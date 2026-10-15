import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeState, encodeState, isAllowedRedirectUri, isAllowedUser, isUserIdToken } from "./security";
import { DEFAULT_REDIRECT_URIS } from "./config";

const allow = DEFAULT_REDIRECT_URIS;

test("allows Claude's hosted callbacks exactly", () => {
  assert.ok(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback", allow));
  assert.ok(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback", allow));
});

test("allows loopback callbacks on any port and path", () => {
  assert.ok(isAllowedRedirectUri("http://localhost:6274/oauth/callback", allow));
  assert.ok(isAllowedRedirectUri("http://127.0.0.1:33418/callback", allow));
});

test("rejects everything else", () => {
  for (const bad of [
    undefined,
    "",
    "not a url",
    "https://evil.example/api/mcp/auth_callback",
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/auth_callback/../../steal",
    "https://claude.ai/somewhere-else",
    "https://claude.ai/api/mcp/auth_callback?next=https://evil.example",
    "https://claude.ai/api/mcp/auth_callback#frag",
    "http://claude.ai/api/mcp/auth_callback",
    "https://localhost:6274/callback",
    "http://localhost.evil.example/callback",
    "http://user:pass@localhost/callback",
    "javascript:alert(1)",
  ]) {
    assert.equal(isAllowedRedirectUri(bad, allow), false, `should reject ${bad}`);
  }
});

test("state round-trips and is tamper-evident", () => {
  const key = "k";
  const state = encodeState({ s: "client-state", r: "https://claude.ai/api/mcp/auth_callback", t: Date.now() }, key);
  assert.equal(decodeState(state, key)?.s, "client-state");

  const [body, mac] = state.split(".");
  const forged = Buffer.from(JSON.stringify({ s: "x", r: "https://evil.example", t: Date.now() })).toString("base64url");
  assert.equal(decodeState(`${forged}.${mac}`, key), null);
  assert.equal(decodeState(`${body}.${mac}`, "other-key"), null);
  assert.equal(decodeState(`${body}.${mac}.extra`, key), null);
  assert.equal(decodeState(undefined, key), null);
});

test("state expires", () => {
  const key = "k";
  const issued = Date.now() - 11 * 60 * 1000;
  const state = encodeState({ s: "", r: "http://localhost/cb", t: issued }, key);
  assert.equal(decodeState(state, key), null);
});

test("email-domain gate", () => {
  assert.ok(isAllowedUser({ preferred_username: "ada@example.com" }, []));
  assert.ok(isAllowedUser({ preferred_username: "ada@Example.com" }, ["example.com"]));
  assert.equal(isAllowedUser({ preferred_username: "eve@evil.example" }, ["example.com"]), false);
  assert.equal(isAllowedUser({}, ["example.com"]), false);
});

test("only v2 user id_tokens from our tenant are accepted as bearers", () => {
  const tid = "t-1";
  const idToken = { ver: "2.0", tid, oid: "o", sub: "s", preferred_username: "ada@example.com" };
  assert.ok(isUserIdToken(idToken, tid));
  assert.ok(isUserIdToken({ ...idToken, roles: ["Reader"] }, tid), "id_tokens may carry app roles");

  // Access tokens minted for our app by some other client in the tenant.
  assert.equal(isUserIdToken({ ...idToken, ver: "1.0", appid: "x" }, tid), false);
  assert.equal(isUserIdToken({ ...idToken, azp: "x", azpacr: "1" }, tid), false);
  assert.equal(isUserIdToken({ ...idToken, scp: "user_impersonation" }, tid), false);
  assert.equal(isUserIdToken({ ...idToken, idtyp: "app" }, tid), false);
  // Wrong tenant, or missing subject.
  assert.equal(isUserIdToken({ ...idToken, tid: "other" }, tid), false);
  assert.equal(isUserIdToken({ ver: "2.0", tid }, tid), false);
});
