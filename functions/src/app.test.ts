import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Fake configuration: these tests never reach Microsoft.
process.env.PBI_TENANT_ID = "00000000-0000-0000-0000-000000000000";
process.env.PBI_CLIENT_ID = "11111111-1111-1111-1111-111111111111";
process.env.PBI_CLIENT_SECRET = "test-secret";
process.env.PUBLIC_URL = "https://pbi-mcp.example.com/";

import { app, methodNotAllowed } from "./app";
import { encodeState } from "./security";

let server: Server;
let base = "";
const get = (path: string) => fetch(`${base}${path}`, { redirect: "manual" });

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("publishes OAuth metadata against PUBLIC_URL", async () => {
  const prm = await (await get("/.well-known/oauth-protected-resource")).json();
  assert.equal(prm.resource, "https://pbi-mcp.example.com");
  const as = await (await get("/.well-known/oauth-authorization-server")).json();
  assert.equal(as.token_endpoint, "https://pbi-mcp.example.com/token");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("MCP endpoint demands a bearer token and points at the metadata", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
});

test("GET on the MCP endpoint also challenges for a token", async () => {
  assert.equal((await fetch(`${base}/mcp`)).status, 401);
});

test("rejects garbage bearer tokens", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer nope" } });
  assert.equal(res.status, 401);
});

const authorizeQuery = new URLSearchParams({
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  state: "abc",
  code_challenge: "x".repeat(43),
  code_challenge_method: "S256",
});

async function startConsent() {
  const res = await get(`/authorize?${authorizeQuery}`);
  const html = await res.text();
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { res, html, ticket, cookie };
}

const approve = (ticket: string, cookie?: string) =>
  fetch(`${base}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams({ ticket }).toString(),
  });

test("authorize shows a consent page naming the destination, unframeable", async () => {
  const { res, html, ticket, cookie } = await startConsent();
  assert.equal(res.status, 200);
  assert.match(html, /Claude \(claude\.ai\)/);
  assert.ok(ticket.length > 20);
  assert.match(cookie, /^__session=/);
  assert.match(res.headers.get("set-cookie") ?? "", /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy") ?? "", /form-action 'self' https:\/\/login\.microsoftonline\.com/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("approving relays to Entra ID with PKCE, signed state and the account picker", async () => {
  const { ticket, cookie } = await startConsent();
  const res = await approve(ticket, cookie);
  assert.equal(res.status, 303);
  const loc = new URL(res.headers.get("location")!);
  assert.equal(loc.host, "login.microsoftonline.com");
  assert.equal(loc.searchParams.get("redirect_uri"), "https://pbi-mcp.example.com/callback");
  assert.equal(loc.searchParams.get("code_challenge"), "x".repeat(43));
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  assert.equal(loc.searchParams.get("prompt"), "select_account");
  assert.match(loc.searchParams.get("state")!, /^[\w-]+\.[\w-]+$/);
});

test("approval is bound to the browser that saw the page", async () => {
  const { ticket } = await startConsent();
  assert.equal((await approve(ticket)).status, 400, "no cookie (e.g. a cross-site auto-submit)");
  assert.equal((await approve(ticket, "__session=someone-else")).status, 400);
  assert.equal((await approve("forged.ticket", "__session=x")).status, 400);
});

test("authorize refuses unknown redirect URIs and missing PKCE", async () => {
  const evil = new URLSearchParams({ redirect_uri: "https://evil.example/cb", code_challenge: "x" });
  assert.equal((await get(`/authorize?${evil}`)).status, 400);
  const noPkce = new URLSearchParams({ redirect_uri: "https://claude.ai/api/mcp/auth_callback" });
  assert.equal((await get(`/authorize?${noPkce}`)).status, 400);
  const plainPkce = new URLSearchParams({
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: "x".repeat(43),
  });
  assert.equal((await get(`/authorize?${plainPkce}`)).status, 400, "missing method means plain, which we refuse");
});

test("callback returns the code only to the signed redirect target", async () => {
  const state = encodeState(
    { s: "abc", r: "https://claude.ai/api/mcp/auth_callback", t: Date.now() },
    "pbi-mcp-state:test-secret"
  );
  const ok = await get(`/callback?code=C0DE&state=${encodeURIComponent(state)}`);
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, "https://claude.ai/api/mcp/auth_callback");
  assert.equal(loc.searchParams.get("code"), "C0DE");
  assert.equal(loc.searchParams.get("state"), "abc");

  // The old, unsigned state format must no longer work.
  const legacy = Buffer.from(JSON.stringify({ original_state: "x", redirect_uri: "https://evil.example" })).toString("base64url");
  assert.equal((await get(`/callback?code=C0DE&state=${legacy}`)).status, 400);
});

test("register refuses disallowed redirect URIs", async () => {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
  });
  assert.equal(res.status, 400);
});

test("token endpoint rejects requests without code + verifier", async () => {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=authorization_code&code=abc",
  });
  assert.equal(res.status, 400);
});

test("authenticated GET/DELETE get 405 Allow: POST (no SSE stream to hang on)", () => {
  const headers: Record<string, string> = {};
  let status = 0;
  const res = {
    set(k: string, v: string) { headers[k] = v; return this; },
    status(code: number) { status = code; return this; },
    json() { return this; },
  };
  methodNotAllowed({} as never, res as never);
  assert.equal(status, 405);
  assert.equal(headers.Allow, "POST");
});
