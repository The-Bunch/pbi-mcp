/**
 * All configuration comes from the environment.
 *
 * Secrets (PBI_TENANT_ID, PBI_CLIENT_ID, PBI_CLIENT_SECRET) live in Google
 * Secret Manager and are bound to the function in index.ts. Everything else is
 * plain config, set in functions/.env (see functions/.env.example).
 *
 * Values are read lazily (at request time, not import time) so the module can
 * be loaded by the Firebase CLI during deploy analysis without secrets present.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function flag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

/**
 * Where MCP clients may be sent back to after sign-in. Exact URLs, except that
 * a bare loopback origin (http://localhost or http://127.0.0.1) matches any
 * port and path on that host, per RFC 8252 §7.3 — that's how desktop clients
 * and the MCP Inspector receive their callback.
 */
export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "http://localhost",
  "http://127.0.0.1",
];

export const config = {
  tenantId: () => required("PBI_TENANT_ID").toLowerCase(),
  clientId: () => required("PBI_CLIENT_ID"),
  clientSecret: () => required("PBI_CLIENT_SECRET"),

  /** Public origin of this server, e.g. https://my-pbi-mcp.web.app (no trailing slash). */
  publicUrl: () => required("PUBLIC_URL").replace(/\/+$/, ""),

  allowedRedirectUris: () => list("ALLOWED_REDIRECT_URIS", DEFAULT_REDIRECT_URIS),

  /** Optional: only users whose sign-in name ends in one of these domains may connect. */
  allowedEmailDomains: () => list("ALLOWED_EMAIL_DOMAINS", []).map((d) => d.toLowerCase()),

  /** Hide and refuse the dataset-refresh tools. */
  readOnly: () => flag("PBI_READ_ONLY"),

  /** Free text appended to the query tools' descriptions — teach the model your warehouse. */
  datasetHint: () => process.env.PBI_DATASET_HINT?.trim() ?? "",

  /** Log Power BI response previews. Off by default: responses contain your data. */
  debug: () => flag("DEBUG"),
};
