// Build step 1 spike (see the spec): one read-only pass E5, E1 -> E4, E6.
// It answers the spec's open questions and never prints cookies or tokens.
//
//   bun scripts/spike.ts                 real run, cookie from config/riot-cookie
//   bun scripts/spike.ts --ua riotclient same, with the RiotClient User-Agent
//   bun scripts/spike.ts --probe         no cookie: only checks that Cloudflare
//                                        lets this runtime and IP reach E1
//
// Plain erasable TypeScript, so `node scripts/spike.ts` runs it on Node 24 too.
// Rotated cookies are saved to data/spike-jar.json (gitignored) and reused on
// the next run, because Riot rotates them on every reauth.

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";

const COOKIE_FILE = process.env.RIOT_COOKIE_FILE ?? "config/riot-cookie";
const JAR_FILE = "data/spike-jar.json";
const VP = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741";
const REAUTH_URL =
  "https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in" +
  "&client_id=play-valorant-web-prod&response_type=token%20id_token&scope=account%20openid&nonce=1";
const UA_SHOOTERGAME = "ShooterGame/13 Windows/10.0.19043.1.256.64bit";
const CLIENT_PLATFORM =
  "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9";
// SkinPeek sends these on every request; its comment says they help with Cloudflare 1020.
const BASE_HEADERS = { "Accept-Language": "en-US,en;q=0.5" };
const DUMMY_COOKIE = { cookie: "dummy=cookie" };

const args = process.argv.slice(2);
const probe = args.includes("--probe");
const uaMode = args.includes("--ua") ? args[args.indexOf("--ua") + 1] : "shootergame";
const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`;

type Jar = Record<string, string>;

const log = (label: string, value: unknown) => console.log(`${label.padEnd(22)} ${value}`);
const fail = (code: number, message: string): never => {
  console.log(`\nFAILED: ${message}`);
  process.exit(code);
};

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(15_000), ...init });
  } catch (err) {
    // Error messages carry the URL at most, never the headers.
    return fail(10, `network error on ${new URL(url).host}: ${(err as Error).message}`);
  }
}

async function json(res: Response, what: string): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return fail(11, `${what} returned ${res.status} with a non-JSON body (${text.length} bytes)`);
  }
}

// ---------- cookie jar ----------

function parseCookieFile(raw: string): Jar {
  let text = raw.replace(/^﻿/, "").trim().replace(/^cookie:\s*/i, "");
  if (!text.includes("=")) text = `ssid=${text}`; // a bare ssid value
  const jar: Jar = {};
  for (const part of text.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return jar;
}

const serialize = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

function mergeSetCookies(jar: Jar, setCookies: string[]): Jar {
  const next = { ...jar };
  for (const line of setCookies) {
    const pair = line.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) next[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return next;
}

async function loadJar(): Promise<{ jar: Jar; sourceHash: string; from: string }> {
  let raw: string;
  try {
    raw = await readFile(COOKIE_FILE, "utf8");
  } catch {
    return fail(1, `no cookie file at ${COOKIE_FILE}. Paste your Riot cookie header into it (see the spec, Auth flow).`);
  }
  if (!raw.trim()) return fail(1, `${COOKIE_FILE} is empty. Paste your Riot cookie header into it.`);
  const sourceHash = createHash("sha256").update(raw.trim()).digest("hex");
  try {
    const saved = JSON.parse(await readFile(JAR_FILE, "utf8"));
    if (saved.sourceHash === sourceHash) return { jar: saved.jar, sourceHash, from: `${JAR_FILE} (rotated)` };
  } catch {
    // no saved jar yet, or the cookie file changed: start from the file
  }
  return { jar: parseCookieFile(raw), sourceHash, from: COOKIE_FILE };
}

async function saveJar(jar: Jar, sourceHash: string) {
  await mkdir("data", { recursive: true });
  const tmp = `${JAR_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ sourceHash, jar, savedAt: new Date().toISOString() }), { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {}); // no-op on Windows
  await rename(tmp, JAR_FILE);
}

// ---------- the run ----------

console.log(`daily-drip spike on ${runtime}${probe ? " (probe, no cookie)" : ""}\n`);

// E5: game version, for X-Riot-ClientVersion and the RiotClient User-Agent
const version = (await json(await request("https://valorant-api.com/v1/version"), "E5")).data;
log("E5 game version", `${version.version} (client ${version.riotClientVersion})`);

const ua = uaMode === "riotclient"
  ? `RiotClient/${version.riotClientBuild} rso-auth (Windows;10;;Professional, x64)`
  : UA_SHOOTERGAME;
log("E1 User-Agent", ua);

const loaded = probe ? null : await loadJar();
if (loaded) log("cookie jar", `${Object.keys(loaded.jar).length} cookies from ${loaded.from}`);

// E1: reauth, without following the redirect
const e1 = await request(REAUTH_URL, {
  redirect: "manual",
  headers: { ...BASE_HEADERS, "User-Agent": ua, cookie: loaded ? serialize(loaded.jar) : "dummy=cookie" },
});
const location = e1.headers.get("location") ?? "";
const setCookies = e1.headers.getSetCookie();
const target = location ? new URL(location, "https://auth.riotgames.com") : null;
// Host and path only: the query and fragment can carry tokens.
const where = target ? `${target.host}${target.pathname}` : "(no Location)";
// SkinPeek checks for "/login"; Riot's newer login page lives on authenticate.riotgames.com.
const toLogin = !!target && (location.startsWith("/login") || target.pathname.startsWith("/login") || target.host === "authenticate.riotgames.com");
log("E1 status", e1.status);
log("E1 redirects to", where);
log("E1 Set-Cookie names", setCookies.map((c) => c.split("=")[0]).join(", ") || "(none)");

if (e1.status === 403 && e1.headers.get("x-frame-options") === "SAMEORIGIN") {
  fail(2, `Cloudflare blocked E1 (403 + x-frame-options: SAMEORIGIN) on ${runtime}. Next: the TLS fallback in the spec (Endpoints, TLS).`);
}
if (e1.status === 429) fail(3, `rate limited (Retry-After: ${e1.headers.get("retry-after") ?? "none"})`);

if (probe) {
  if (e1.status === 303 && toLogin) {
    console.log(`\nPROBE OK: Cloudflare let ${runtime} through from this IP (303 to the login page, as expected without a cookie).`);
    process.exit(0);
  }
  fail(5, `unexpected E1 answer without a cookie: ${e1.status} to ${where}`);
}

if (toLogin) {
  fail(4, `cookie dead: Riot redirected to ${where}. Copy a fresh cookie header into the cookie file.`);
}

// Save rotated cookies before anything else can fail.
await saveJar(mergeSetCookies(loaded!.jar, setCookies), loaded!.sourceHash);
log("rotated cookies", `saved to ${JAR_FILE}`);

const fragment = new URLSearchParams(location.split("#")[1] ?? "");
const accessToken = fragment.get("access_token");
const idToken = fragment.get("id_token");
if (e1.status !== 303 || !accessToken || !idToken) {
  fail(5, `no token in the E1 redirect (status ${e1.status}); the spec treats this as a Cloudflare block`);
}
log("E1 tokens", `access_token ${accessToken!.length} chars, id_token ${idToken!.length} chars`);
const bearer = { Authorization: `Bearer ${accessToken}` };

// E2: entitlements
const e2 = await request("https://entitlements.auth.riotgames.com/api/token/v1", {
  method: "POST",
  headers: { ...BASE_HEADERS, ...DUMMY_COOKIE, ...bearer, "Content-Type": "application/json" },
});
const entitlements = (await json(e2, "E2")).entitlements_token as string | undefined;
if (!entitlements) fail(6, `E2 returned ${e2.status} without entitlements_token`);
log("E2 entitlements", `${e2.status}, ${entitlements!.length} chars`);

// E3: userinfo -> PUUID
const e3 = await json(await request("https://auth.riotgames.com/userinfo", { headers: { ...BASE_HEADERS, ...DUMMY_COOKIE, ...bearer } }), "E3");
const puuid = e3.sub as string;
if (!puuid) fail(8, "E3 userinfo returned no sub (PUUID)");
log("E3 account", `${e3.acct ? `${e3.acct.game_name}#${e3.acct.tag_line}` : "(no acct)"}, PUUID ${puuid.slice(0, 8)}…`);

// E4: region -> shard
const e4 = await json(
  await request("https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant", {
    method: "PUT",
    headers: { ...BASE_HEADERS, ...DUMMY_COOKIE, ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: idToken }),
  }),
  "E4",
);
const region = e4.affinities?.live as string;
if (!region && !process.env.RIOT_SHARD) fail(8, "E4 returned no affinities.live; set RIOT_SHARD (e.g. ap) to skip it");
const shard = process.env.RIOT_SHARD ?? (region === "latam" || region === "br" ? "na" : region);
log("E4 region / shard", `${region} / ${shard}${process.env.RIOT_SHARD ? " (RIOT_SHARD override)" : ""}`);

// E6: storefront v3
const e6res = await request(`https://pd.${shard}.a.pvp.net/store/v3/storefront/${puuid}`, {
  method: "POST",
  headers: {
    ...BASE_HEADERS,
    ...DUMMY_COOKIE,
    ...bearer,
    "X-Riot-Entitlements-JWT": entitlements!,
    "X-Riot-ClientVersion": version.riotClientVersion,
    "X-Riot-ClientPlatform": CLIENT_PLATFORM,
    "Content-Type": "application/json",
  },
  body: "{}",
});
const shop = await json(e6res, "E6");
if (shop.errorCode) fail(7, `E6 ${e6res.status} ${shop.errorCode}: ${shop.message ?? ""}`);
log("E6 status", e6res.status);
log("E6 top-level keys", Object.keys(shop).join(", "));

const panel = shop.SkinsPanelLayout;
if (!panel?.SingleItemOffers) fail(7, `E6 ${e6res.status} has no SkinsPanelLayout.SingleItemOffers`);
const offers: string[] = panel.SingleItemOffers;
const remaining: number = panel.SingleItemOffersRemainingDurationInSeconds;
const storeOffers: any[] = panel.SingleItemStoreOffers ?? [];
const priceOf = (uuid: string) => storeOffers.find((o) => o.OfferID === uuid)?.Cost?.[VP];

console.log("\nToday's shop:");
for (const uuid of offers) {
  const level = await request(`https://valorant-api.com/v1/weapons/skinlevels/${uuid}`);
  const name = level.ok ? (await level.json()).data.displayName : `(unknown ${uuid})`;
  const vp = priceOf(uuid);
  console.log(`  ${String(name).padEnd(40)} ${vp ? `${vp} VP` : "price not in E6"}`);
}
const resetAt = new Date(Date.now() + remaining * 1000);
console.log(`  resets ${resetAt.toLocaleString()} (in ${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m)`);

console.log("\nAnswers for the spec:");
log("TLS + IP", `E1 passed on ${runtime}`);
log("User-Agent", `${uaMode} accepted`);
log("shard", shard);
log("prices in v3", offers.every((u) => priceOf(u)) ? "yes: E7 can be skipped" : "no: E7 is needed");
