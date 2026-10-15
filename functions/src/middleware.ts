import { Request, Response, NextFunction } from "express";
import jwt, { JwtHeader, JwtPayload, SigningKeyCallback } from "jsonwebtoken";
import jwksRsa from "jwks-rsa";
import { config } from "./config";
import { isAllowedUser, isUserIdToken } from "./security";

let jwksClient: jwksRsa.JwksClient | null = null;

function getJwksClient() {
  if (!jwksClient) {
    jwksClient = jwksRsa({
      jwksUri: `https://login.microsoftonline.com/${config.tenantId()}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxAge: 24 * 60 * 60 * 1000,
      rateLimit: true,
    });
  }
  return jwksClient;
}

function getKey(header: JwtHeader, callback: SigningKeyCallback) {
  getJwksClient().getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key?.getPublicKey());
  });
}

function challenge(res: Response, status: number, error: string) {
  const base = config.publicUrl();
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-protected-resource"`
  );
  res.status(status).json({ error });
}

/**
 * Every MCP request must carry an Entra ID **user id_token**: issued by *your*
 * tenant (v2 endpoint) for *your* app registration, signed by Microsoft, still
 * in date — and not an access token. Other apps in the tenant can mint access
 * tokens audienced to this app via client credentials; isUserIdToken() is what
 * keeps those out.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    challenge(res, 401, "No token provided");
    return;
  }

  const tenantId = config.tenantId();
  jwt.verify(
    token,
    getKey,
    {
      audience: config.clientId(),
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      algorithms: ["RS256"],
    },
    (err, decoded) => {
      if (err) {
        console.warn(`[auth] token rejected: ${err.message}`);
        challenge(res, 401, "Invalid or expired token");
        return;
      }
      const claims = (decoded ?? {}) as JwtPayload;
      if (!isUserIdToken(claims, tenantId)) {
        console.warn("[auth] token rejected: not a v2 user id_token");
        challenge(res, 401, "Invalid or expired token");
        return;
      }
      if (!isAllowedUser(claims, config.allowedEmailDomains())) {
        console.warn("[auth] user outside ALLOWED_EMAIL_DOMAINS");
        res.status(403).json({ error: "This account is not allowed to use this server" });
        return;
      }
      next();
    }
  );
}
