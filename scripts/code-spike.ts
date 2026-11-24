// Sign-in link spike (spec: Accounts, onboarding). One read-only pass that stores nothing:
//   1. build a Riot sign-in link (the Riot Client's OAuth "authorization code" flow) and write it
//      to a file, for the host to open in a browser;
//   2. the person signs in on Riot's own page; the browser then lands on a dead
//      http://localhost/redirect?code=... address, which goes into a second file;
//   3. trade the one-time code for tokens, including a refresh token;
//   4. use the refresh token once (it rotates), then run E2, E3, E4, E5 and the bot's own E6.
// It answers: can a member link with a sign-in link instead of a cookie or Riot Mobile, and does
// the refresh token reach the shop? It prints statuses, field names and a short hash of the
// PUUID; never a code, a token or a cookie.
//
//   AUTH_URL_FILE=auth-url.txt REDIRECT_FILE=redirect.txt bun scripts/code-spike.ts
//
// The requests follow the open-source implementations the spec names (Accounts).

import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fetchGameVersion } from "../src/catalog.ts";
import { createHttp } from "../src/http.ts";
import { addSecret, redact } from "../src/log.ts";
import { ENTITLEMENTS_URL, PAS_URL, regionToShard, USERINFO_URL } from "../src/riot/auth.ts";
import { fetchStorefront } from "../src/riot/store.ts";

const AUTHORIZE = "https://auth.riotgames.com/authorize";
const TOKEN = "https://auth.riotgames.com/token";
const CLIENT_ID = "riot-client";
const REDIRECT_URI = "http://localhost/redirect";
// offline_access is what makes Riot return a refresh token.
const SCOPE = "openid link ban lol_region account offline_access";
const UA = "RiotGamesApi/24.10.1.4471 rso-auth (Windows;10;;Professional, x64) riot_client/0";
const AUTH_URL_FILE = process.env.AUTH_URL_FILE ?? "auth-url.txt";
const REDIRECT_FILE = process.env.REDIRECT_FILE ?? "redirect.txt";
const WAIT_MS = 5 * 60_000;

const http = createHttp();
const say = (label: string, value: unknown) => console.log(redact(`${label.padEnd(26)} ${value}`));
const fail = async (code: number, message: string): Promise<never> => {
  await rm(REDIRECT_FILE, { force: true });
  await rm(AUTH_URL_FILE, { force: true });
  console.log(redact(`\nFAILED: ${message}`));
  process.exit(code);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 10);
const fields = (body: Record<string, unknown>) => Object.keys(body).sort().join(", ");

/**
 * The code from a pasted redirect address; the "code" query parameter, URL-decoded. https is
 * accepted too: browsers in HTTPS-only mode rewrite http://localhost before the page fails.
 */
export function extractCode(pasted: string): string | null {
  try {
    const url = new URL(pasted.trim());
    if (url.hostname !== "localhost" || url.pathname !== "/redirect") return null;
    return url.searchParams.get("code");
  } catch {
    return null;
  }
}

async function token(params: Record<string, string>, what: string): Promise<Record<string, any>> {
  const res = await http.request(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    // reported below
  }
  for (const key of ["access_token", "id_token", "refresh_token"]) if (typeof body[key] === "string") addSecret(body[key]);
  if (!res.ok || typeof body.access_token !== "string") {
    // Riot's OAuth errors are short codes such as invalid_grant; they hold no secret.
    await fail(4, `${what} answered ${res.status}${body.error ? ` (${body.error})` : ""}`);
  }
  return body;
}

console.log(`daily-drip sign-in link spike on Bun ${process.versions.bun ?? "?"} (nothing is stored)\n`);

// 1. The sign-in link.
const authUrl = `${AUTHORIZE}?${new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: SCOPE, nonce: randomUUID() })}`;
await writeFile(AUTH_URL_FILE, authUrl, { mode: 0o600 });
say("sign-in link", "ready; sign in on Riot's page, then copy the localhost address");

// 2. Wait for the redirect address.
const deadline = Date.now() + WAIT_MS;
let code: string | null = null;
while (!code) {
  if (Date.now() > deadline) await fail(3, "no redirect address within 5 minutes");
  await sleep(1_000);
  const pasted = await readFile(REDIRECT_FILE, "utf8").catch(() => "");
  if (!pasted) continue;
  code = extractCode(pasted);
  await rm(REDIRECT_FILE, { force: true });
  if (!code) await fail(3, "that address has no code; copy the whole http://localhost/redirect?code=... address");
}
addSecret(code);
await rm(AUTH_URL_FILE, { force: true });
say("redirect address", "received");

// 3. Code -> tokens.
const first = await token({ grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID }, "the code exchange");
say("code exchange", `ok; fields: ${fields(first)}`);
say("access token lifetime", `${first.expires_in ?? "?"} s`);
if (typeof first.refresh_token !== "string") await fail(5, "no refresh_token: without one a member would have to sign in again every hour");

// 4. Refresh once, the way every scheduled run would.
const second = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID }, "the refresh");
say("refresh", `ok; fields: ${fields(second)}`);
say("refresh token rotated", typeof second.refresh_token === "string" && second.refresh_token !== first.refresh_token ? "yes" : "no");

const accessToken: string = second.access_token;
const idToken: string = second.id_token ?? first.id_token ?? "";
const bearer = { Authorization: `Bearer ${accessToken}` };
const jsonHeaders = { ...bearer, "Content-Type": "application/json" };

const e2 = await http.request(ENTITLEMENTS_URL, { method: "POST", headers: jsonHeaders });
const entitlementsToken = e2.ok ? ((await e2.json()) as Record<string, any>).entitlements_token : undefined;
if (typeof entitlementsToken === "string") addSecret(entitlementsToken);
say("E2 entitlements", `${e2.status}, token: ${entitlementsToken ? "yes" : "no"}`);

const e3 = await http.request(USERINFO_URL, { headers: bearer });
const userinfo = e3.ok ? ((await e3.json()) as Record<string, any>) : {};
const puuid = typeof userinfo.sub === "string" ? userinfo.sub : "";
say("E3 userinfo", `${e3.status}, PUUID sha256: ${puuid ? shortHash(puuid) : "none"}, Riot ID present: ${userinfo.acct?.game_name ? "yes" : "no"}`);

const e4 = await http.request(PAS_URL, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ id_token: idToken }) });
const region = e4.ok ? ((await e4.json()) as Record<string, any>).affinities?.live : undefined;
const shard = typeof region === "string" ? regionToShard(region) : "";
say("E4 shard", `${e4.status}, ${shard || "none"}`);
if (!entitlementsToken || !puuid || !shard) await fail(6, "E2, E3 or E4 failed with the refreshed token");

const version = await fetchGameVersion(http);
const storefront = await fetchStorefront(http, { accessToken, idToken, entitlementsToken, puuid, shard, riotName: null }, version.riotClientVersion);
say("E6 storefront", `${storefront.offers.length} offers, resets in ${Math.round(storefront.remainingSeconds / 3600)} h`);

console.log("\nCODE SPIKE OK: a sign-in link gives a refresh token that reaches the shop, with no cookie and no Riot Mobile.");
