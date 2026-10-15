import { Router, Request, Response } from "express";
import axios from "axios";
import { config } from "./config";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { decodeState, encodeState, isAllowedRedirectUri } from "./security";
import { consentPage } from "./consent";

/**
 * A thin OAuth 2.1 facade in front of Microsoft Entra ID.
 *
 * MCP clients (Claude and friends) expect the server to publish OAuth metadata,
 * accept dynamic client registration and run an authorization-code + PKCE flow.
 * Entra ID can't do dynamic registration and only accepts pre-registered
 * redirect URIs, so this router speaks MCP-flavoured OAuth on the outside and
 * relays to a single Entra app registration on the inside.
 */
const router = Router();

const ENTRA_SCOPES = "openid profile email offline_access User.Read";
const callbackUrl = () => `${config.publicUrl()}/callback`;
const entra = (path: string) => `https://login.microsoftonline.com/${config.tenantId()}/oauth2/v2.0/${path}`;
const stateKey = () => `pbi-mcp-state:${config.clientSecret()}`;
// A different key, so a consent ticket can never pass as Entra state or vice versa.
const consentKey = () => `pbi-mcp-consent:${config.clientSecret()}`;

// MCP clients run in browsers as well as on desktops.
router.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, mcp-protocol-version"
  );
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  next();
});

router.options("*", (_req, res) => res.sendStatus(204));

// OAuth 2.0 Protected Resource Metadata (RFC 9728) — where MCP clients start.
const protectedResource = (_req: Request, res: Response) => {
  const base = config.publicUrl();
  res.json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email"],
  });
};
router.get("/.well-known/oauth-protected-resource", protectedResource);
router.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

// OAuth 2.0 Authorization Server Metadata (RFC 8414).
router.get("/.well-known/oauth-authorization-server", (_req, res) => {
  const base = config.publicUrl();
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid", "profile", "email"],
  });
});

// Dynamic Client Registration (RFC 7591).
// Every client gets the same public client id: identity is proven by Entra ID
// at sign-in, and redirect targets are policed by ALLOWED_REDIRECT_URIS.
router.post("/register", (req: Request, res: Response) => {
  const { redirect_uris, client_name } = req.body ?? {};
  const uris: string[] = Array.isArray(redirect_uris) ? redirect_uris : [];
  const allowed = config.allowedRedirectUris();
  const rejected = uris.filter((u) => !isAllowedRedirectUri(u, allowed));
  if (rejected.length > 0) {
    res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: `redirect_uri not allowed by this server: ${rejected.join(", ")}`,
    });
    return;
  }
  res.status(201).json({
    client_id: "pbi-mcp-client",
    redirect_uris: uris,
    client_name: client_name || "PBI MCP client",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

// Step 1: the client sends the user here. Check where they'll come back to,
// then ask the user to approve the connection on a page of our own.
//
// Every MCP client shares one client id and Entra may sign the user in without
// a prompt, so without this page a link someone else crafted could connect
// your account to their session. The page names the destination, and the
// approval is bound to this browser by a SameSite cookie.
router.get("/authorize", (req: Request, res: Response) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } =
    req.query as Record<string, string | undefined>;

  if (!isAllowedRedirectUri(redirect_uri, config.allowedRedirectUris())) {
    res.status(400).send("redirect_uri is not allowed by this server.");
    return;
  }
  // PKCE is mandatory: a leaked code is useless without the client's verifier.
  if (!code_challenge || code_challenge_method !== "S256") {
    res.status(400).send("PKCE with code_challenge_method=S256 is required.");
    return;
  }

  const nonce = randomBytes(18).toString("base64url");
  const ticket = encodeState(
    { s: state ?? "", r: redirect_uri!, t: Date.now(), c: code_challenge, n: nonce },
    consentKey()
  );

  // Firebase Hosting forwards only the cookie named __session.
  res.setHeader(
    "Set-Cookie",
    `__session=${nonce}; Path=/authorize; Max-Age=600; HttpOnly; Secure; SameSite=Lax`
  );
  noFraming(res);
  res.type("html").send(consentPage(redirect_uri!, ticket));
});

// Step 1b: the user clicked Approve. Check the ticket and the cookie, then hand
// off to Entra ID with our own (registered) callback.
router.post("/authorize", (req: Request, res: Response) => {
  const ticket = decodeState(req.body?.ticket, consentKey());
  const cookie = readCookie(req.headers.cookie, "__session");
  if (
    !ticket ||
    !ticket.c ||
    !ticket.n ||
    !cookie ||
    !safeEqual(ticket.n, cookie) ||
    !isAllowedRedirectUri(ticket.r, config.allowedRedirectUris())
  ) {
    res.status(400).send("This approval has expired or didn't start in this browser. Please connect again.");
    return;
  }

  res.setHeader("Set-Cookie", "__session=; Path=/authorize; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  const params = new URLSearchParams({
    client_id: config.clientId(),
    response_type: "code",
    redirect_uri: callbackUrl(),
    scope: ENTRA_SCOPES,
    state: encodeState({ s: ticket.s, r: ticket.r, t: Date.now() }, stateKey()),
    code_challenge: ticket.c,
    code_challenge_method: "S256",
    // Never sign in silently: the user sees which account is being connected.
    prompt: "select_account",
  });

  res.redirect(303, `${entra("authorize")}?${params}`);
});

// Step 2: Entra ID sends the user back here. Verify our signed state, then
// return the code to the client that started the flow.
router.get("/callback", (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

  const decoded = decodeState(state, stateKey());
  if (!decoded || !isAllowedRedirectUri(decoded.r, config.allowedRedirectUris())) {
    res.status(400).send("Invalid or expired sign-in state. Please try connecting again.");
    return;
  }

  const target = new URL(decoded.r);
  if (decoded.s) target.searchParams.set("state", decoded.s);
  if (error || !code) {
    target.searchParams.set("error", error || "server_error");
    if (error_description) target.searchParams.set("error_description", error_description);
  } else {
    target.searchParams.set("code", code);
  }
  res.redirect(target.toString());
});

// Step 3: the client swaps the code (plus its PKCE verifier) for a token.
// We add the confidential client secret and relay to Entra ID.
router.post("/token", async (req: Request, res: Response) => {
  const { code, code_verifier, grant_type, refresh_token } = req.body ?? {};

  const body: Record<string, string> = {
    client_id: config.clientId(),
    client_secret: config.clientSecret(),
    scope: ENTRA_SCOPES,
  };

  if (grant_type === "refresh_token" && refresh_token) {
    body.grant_type = "refresh_token";
    body.refresh_token = refresh_token;
  } else if ((grant_type ?? "authorization_code") === "authorization_code" && code && code_verifier) {
    body.grant_type = "authorization_code";
    body.code = code;
    body.code_verifier = code_verifier;
    body.redirect_uri = callbackUrl();
  } else {
    res.status(400).json({ error: "invalid_request", error_description: "Unsupported grant or missing parameters." });
    return;
  }

  try {
    const { data } = await axios.post(entra("token"), new URLSearchParams(body), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15_000,
    });

    // Entra's access_token is audienced for Microsoft Graph, which we can't
    // validate. The id_token is audienced for *our* app registration, so it is
    // what the client presents back to us as its bearer token.
    if (!data.id_token) {
      res.status(502).json({ error: "server_error", error_description: "Entra ID returned no id_token." });
      return;
    }
    console.log(`[token] ${body.grant_type} ok`);
    res.json({
      access_token: data.id_token,
      token_type: "Bearer",
      expires_in: idTokenLifetime(data.id_token),
      refresh_token: data.refresh_token,
      scope: "openid profile email",
    });
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: { error?: string; error_description?: string } } };
    const azure = e.response?.data;
    // Log the error code only — never the request body (it holds the client secret).
    console.error(`[token] ${body.grant_type} failed: ${azure?.error ?? e.response?.status ?? "network"}`);
    res.status(400).json({
      error: azure?.error ?? "invalid_grant",
      error_description: azure?.error_description ?? "Token exchange failed.",
    });
  }
});

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function noFraming(res: Response) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://login.microsoftonline.com; frame-ancestors 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

/** Seconds until the id_token expires (minus a minute's slack). Entra's own
 * expires_in describes the Graph access token, which lives longer. */
function idTokenLifetime(idToken: string): number {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    if (typeof payload.exp !== "number") return 3000;
    return Math.max(0, Math.floor(payload.exp - Date.now() / 1000) - 60);
  } catch {
    return 3000;
  }
}

export default router;
