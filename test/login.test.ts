import { expect, test } from "bun:test";
import type { Http, RequestOptions } from "../src/http.ts";
import { RateLimitedError } from "../src/riot/auth.ts";
import {
  buildSignInUrl,
  CLIENT_ID,
  exchangeCode,
  extractCode,
  LoginDeadError,
  LoginFailedError,
  REDIRECT_URI,
  refreshTokens,
  SCOPE,
  TOKEN_URL,
} from "../src/riot/login.ts";

const CODE = "YXMxOmZpRW1WSVhlaTFrNDZkTUlNVTAycUEu";

/** A fake client: records each request and answers with the given status and JSON. */
function fakeHttp(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; options: RequestOptions }[] = [];
  const http: Http = {
    async request(url, options = {}) {
      calls.push({ url, options });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    },
  };
  return { http, calls, form: () => new URLSearchParams(calls[0]?.options.body ?? "") };
}

test("the sign-in link asks Riot for a code and a refresh token, sent back to localhost", () => {
  const url = new URL(buildSignInUrl("n1"));
  expect(url.origin + url.pathname).toBe("https://auth.riotgames.com/authorize");
  expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("scope")).toBe(SCOPE);
  expect(SCOPE).toContain("offline_access"); // without it there is no refresh token
  expect(url.searchParams.get("nonce")).toBe("n1");
});

test("extractCode reads the code from http and https localhost addresses", () => {
  expect(extractCode(`http://localhost/redirect?iss=x&code=${CODE}`)).toBe(CODE);
  expect(extractCode(`  https://localhost/redirect?code=${CODE}&session_state=s  `)).toBe(CODE);
  // Padded base64 arrives URL-encoded and is decoded.
  expect(extractCode("http://localhost/redirect?code=abcdefgh%3D%3D")).toBe("abcdefgh==");
});

test("extractCode also takes the address without http://, a piece with code=, or the bare code", () => {
  // Selecting the address bar by hand can drop the scheme.
  expect(extractCode(`localhost/redirect?iss=https%3A%2F%2Fauth.riotgames.com&session_state=a.b&code=${CODE}`)).toBe(CODE);
  expect(extractCode(`...&session_state=a.b&code=${CODE}`)).toBe(CODE);
  expect(extractCode(`code=${CODE}`)).toBe(CODE);
  expect(extractCode(CODE)).toBe(CODE);
  // A bare code copied from the bar can still be URL-encoded.
  expect(extractCode("YXMxOmZpRW1WSVhlaTFrNDZkTUlNVTAycUEu%3D%3D")).toBe("YXMxOmZpRW1WSVhlaTFrNDZkTUlNVTAycUEu==");
});

test("extractCode refuses text without a code, and anything that looks like a cookie or token", () => {
  expect(extractCode("http://localhost/redirect?state=1")).toBeNull();
  expect(extractCode("not a url")).toBeNull();
  expect(extractCode("")).toBeNull();
  expect(extractCode("code=short")).toBeNull();
  // A JWT (an ssid cookie value, an access token) pasted by mistake is never sent to Riot as a code.
  expect(extractCode("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl")).toBeNull();
  expect(extractCode("http://localhost/redirect?code=eyJhbGciOiJIUzI1NiJ9.e30.sig")).toBeNull();
  expect(extractCode("ssid=eyJhbGciOiJIUzI1NiJ9.e30.sig; clid=abc")).toBeNull();
});

test("exchangeCode posts the code form-encoded and returns all three tokens", async () => {
  const fake = fakeHttp(200, { access_token: "at-1", id_token: "it-1", refresh_token: "rt-1", expires_in: 3600 });
  const tokens = await exchangeCode(fake.http, CODE);
  expect(tokens).toEqual({ accessToken: "at-1", idToken: "it-1", refreshToken: "rt-1", expiresInSeconds: 3600 });
  expect(fake.calls[0]?.url).toBe(TOKEN_URL);
  expect(fake.calls[0]?.options.method).toBe("POST");
  expect(fake.calls[0]?.options.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
  expect(Object.fromEntries(fake.form())).toEqual({ grant_type: "authorization_code", code: CODE, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID });
});

test("refreshTokens returns a rotated refresh token when Riot sends one", async () => {
  const fake = fakeHttp(200, { access_token: "at-2", id_token: "it-2", refresh_token: "rt-2" });
  expect((await refreshTokens(fake.http, "rt-1")).refreshToken).toBe("rt-2");
  expect(Object.fromEntries(fake.form())).toEqual({ grant_type: "refresh_token", refresh_token: "rt-1", client_id: CLIENT_ID });
});

test("refreshTokens keeps the old refresh token when Riot doesn't rotate it", async () => {
  const fake = fakeHttp(200, { access_token: "at-2", id_token: "it-2" });
  expect((await refreshTokens(fake.http, "rt-1")).refreshToken).toBe("rt-1");
});

test("invalid_grant means the member must link again", async () => {
  await expect(refreshTokens(fakeHttp(400, { error: "invalid_grant" }).http, "rt-1")).rejects.toBeInstanceOf(LoginDeadError);
  await expect(exchangeCode(fakeHttp(400, { error: "invalid_grant" }).http, CODE)).rejects.toBeInstanceOf(LoginDeadError);
});

test("other token errors fail without leaking a token, and 429 is a rate limit", async () => {
  const failed = exchangeCode(fakeHttp(400, { error: "invalid_request" }).http, CODE);
  await expect(failed).rejects.toBeInstanceOf(LoginFailedError);
  await expect(failed).rejects.toThrow("the code exchange answered 400 (invalid_request)");
  await expect(exchangeCode(fakeHttp(200, { token_type: "Bearer" }).http, CODE)).rejects.toBeInstanceOf(LoginFailedError);
  await expect(exchangeCode(fakeHttp(429, {}, { "retry-after": "120" }).http, CODE)).rejects.toBeInstanceOf(RateLimitedError);
});

test("a first sign-in without a refresh token is refused", async () => {
  await expect(exchangeCode(fakeHttp(200, { access_token: "at-1", id_token: "it-1" }).http, CODE)).rejects.toThrow("no refresh token");
});
