import { createHmac, timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Is `candidate` a redirect URI we're willing to send an authorization code to?
 *
 * - Exact match on scheme + host + port + path for normal entries
 *   (query strings and fragments are never allowed).
 * - A bare loopback entry such as "http://localhost" matches any port and path
 *   on that loopback host (RFC 8252 §7.3), which native/desktop clients need.
 */
export function isAllowedRedirectUri(candidate: string | undefined, allowed: string[]): boolean {
  if (!candidate) return false;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;

  for (const entry of allowed) {
    let rule: URL;
    try {
      rule = new URL(entry);
    } catch {
      continue;
    }

    const isLoopbackRule =
      rule.protocol === "http:" &&
      LOOPBACK_HOSTS.has(rule.hostname) &&
      rule.port === "" &&
      (rule.pathname === "/" || rule.pathname === "");

    if (isLoopbackRule) {
      if (url.protocol === "http:" && url.hostname === rule.hostname) return true;
      continue;
    }

    if (
      url.protocol === rule.protocol &&
      url.host === rule.host &&
      url.pathname === rule.pathname &&
      url.search === ""
    ) {
      return true;
    }
  }
  return false;
}

export interface StatePayload {
  /** The MCP client's own `state`, handed back to it untouched. */
  s: string;
  /** The MCP client's redirect_uri. */
  r: string;
  /** Issued-at, ms since epoch. */
  t: number;
  /** PKCE code challenge (consent tickets only). */
  c?: string;
  /** Browser-binding nonce, matched against a cookie (consent tickets only). */
  n?: string;
}

function sign(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

/**
 * We bounce through Entra ID with our own redirect URI, so the client's
 * redirect_uri and state ride along in Entra's `state`. Signing it means
 * /callback can trust where it's about to send the code.
 */
export function encodeState(payload: StatePayload, key: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

export function decodeState(
  state: string | undefined,
  key: string,
  maxAgeMs = 10 * 60 * 1000,
  now = Date.now()
): StatePayload | null {
  if (!state) return null;
  const [body, mac, extra] = state.split(".");
  if (!body || !mac || extra !== undefined) return null;

  const expected = Buffer.from(sign(body, key));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as StatePayload;
    if (typeof payload.r !== "string" || typeof payload.t !== "number") return null;
    if (now - payload.t > maxAgeMs || payload.t > now + 60_000) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Optional sign-in domain gate. Empty allow-list means "anyone the tenant lets in". */
export function isAllowedUser(claims: Record<string, unknown>, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const name = [claims.preferred_username, claims.email, claims.upn].find(
    (v): v is string => typeof v === "string" && v.includes("@")
  );
  if (!name) return false;
  const domain = name.split("@").pop()!.toLowerCase();
  return domains.includes(domain);
}

/**
 * Entra access tokens (app-only or delegated) can share an audience with our
 * id_tokens. They always carry claims an id_token never does, so refuse any
 * token bearing them, and insist on the shape of a v2 user id_token.
 */
const ACCESS_TOKEN_CLAIMS = ["scp", "azp", "azpacr", "appid", "appidacr"];

export function isUserIdToken(claims: Record<string, unknown>, tenantId: string): boolean {
  if (claims.ver !== "2.0") return false;
  if (claims.tid !== tenantId) return false;
  if (typeof claims.oid !== "string" || typeof claims.sub !== "string") return false;
  if (claims.idtyp === "app") return false;
  return !ACCESS_TOKEN_CLAIMS.some((c) => c in claims);
}
