// Auth flow (spec: Auth flow): trade the cookie jar for fresh tokens, E1 -> E4.
// Tokens live only in memory for one run; the rotated cookie jar is saved at once.

import { readFile } from "node:fs/promises";
import { hashCookieFile, mergeSetCookies, parseCookieFile, serializeJar } from "../cookies.ts";
import type { Http } from "../http.ts";
import { addSecret, log } from "../log.ts";
import { importSpikeJar, type State } from "../state.ts";

export const REAUTH_URL =
  "https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in" +
  "&client_id=play-valorant-web-prod&response_type=token%20id_token&scope=account%20openid&nonce=1";
export const ENTITLEMENTS_URL = "https://entitlements.auth.riotgames.com/api/token/v1";
export const USERINFO_URL = "https://auth.riotgames.com/userinfo";
export const PAS_URL = "https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant";
// What SkinPeek actually sends (spec: Endpoints, User-Agent).
export const USER_AGENT = "ShooterGame/13 Windows/10.0.19043.1.256.64bit";

/** The cookie no longer works, or there is none. Alert once; wait for a new cookie file. */
export class CookieDeadError extends Error {
  name = "CookieDeadError";
}

/** Cloudflare (or something else) refused E1. Alert once; retry hourly. */
export class CloudflareBlockedError extends Error {
  name = "CloudflareBlockedError";
}

export class RateLimitedError extends Error {
  name = "RateLimitedError";
  readonly retryAfterSeconds: number;

  constructor(where: string, retryAfterSeconds: number) {
    super(`rate limited by ${where}; retry after ${retryAfterSeconds} s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A Riot endpoint answered in a way the spec does not expect. The run fails; the retry timer takes over. */
export class UnexpectedResponseError extends Error {
  name = "UnexpectedResponseError";
}

export interface Session {
  accessToken: string;
  idToken: string;
  entitlementsToken: string;
  puuid: string;
  shard: string;
  /** The Riot ID ("gameName#tagLine") from E3, for display on shop posts; null if Riot didn't say. */
  riotName: string | null;
}

export interface AuthDeps {
  http: Http;
  state: State;
  save: (state: State) => Promise<void>;
  cookieFile: string;
  shardOverride?: string;
  spikeJarFile?: string;
}

export type ReauthOutcome =
  | { kind: "ok"; accessToken: string; idToken: string }
  | { kind: "dead"; where: string }
  | { kind: "blocked"; reason: string }
  | { kind: "rate-limited"; retryAfterSeconds: number };

/** Read E1's answer (spec: Auth flow, step 2; Error handling). */
export function classifyReauth(status: number, headers: Headers, now = Date.now()): ReauthOutcome {
  if (status === 429) return { kind: "rate-limited", retryAfterSeconds: parseRetryAfter(headers.get("retry-after"), now) };
  if (status === 403) {
    const cloudflare = headers.get("x-frame-options") === "SAMEORIGIN";
    return { kind: "blocked", reason: cloudflare ? "403 with x-frame-options: SAMEORIGIN (Cloudflare)" : "403" };
  }
  const location = headers.get("location");
  if (!location) return { kind: "blocked", reason: `status ${status} without a Location header` };
  const target = new URL(location, "https://auth.riotgames.com");
  const where = `${target.host}${target.pathname}`; // never the query or fragment: they can hold tokens
  // SkinPeek checks for a relative "/login"; on 2026-11-23 Riot redirected to authenticate.riotgames.com/login.
  if (target.host === "authenticate.riotgames.com" || target.pathname.startsWith("/login")) {
    return { kind: "dead", where };
  }
  const tokens = parseTokenFragment(location);
  if (!tokens) return { kind: "blocked", reason: `status ${status}, no token in the redirect to ${where}` };
  return { kind: "ok", ...tokens };
}

export function parseTokenFragment(location: string): { accessToken: string; idToken: string } | null {
  const hash = location.indexOf("#");
  if (hash < 0) return null;
  const params = new URLSearchParams(location.slice(hash + 1));
  const accessToken = params.get("access_token");
  const idToken = params.get("id_token");
  return accessToken && idToken ? { accessToken, idToken } : null;
}

/** Retry-After as seconds or an HTTP date; 1 h when absent or unreadable (Storefront README). */
export function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 3600;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 3600 : Math.max(0, Math.ceil((date - now) / 1000));
}

/** affinities.live -> pd shard (SkinPeek's userRegion). */
export function regionToShard(region: string): string {
  return region === "latam" || region === "br" ? "na" : region;
}

/**
 * Auth flow, step 1: make the jar match the cookie file. A new file replaces the jar,
 * clears the account caches (it may be another account) and clears cookieDeadNotified.
 */
export async function syncCookieSource(deps: AuthDeps): Promise<void> {
  const { state } = deps;
  let raw: string;
  try {
    raw = await readFile(deps.cookieFile, "utf8");
  } catch {
    if (state.cookie) {
      log.warn("cookie file not found; carrying on with the saved cookie jar", { cookieFile: deps.cookieFile });
      return;
    }
    throw new CookieDeadError(`no cookie file at ${deps.cookieFile}`);
  }

  const sourceHash = hashCookieFile(raw);
  if (state.cookie?.sourceHash === sourceHash) return;

  if (await importSpikeJar(state, sourceHash, deps.spikeJarFile)) {
    log.info("imported the spike's rotated cookies", { from: deps.spikeJarFile ?? "data/spike-jar.json" });
  } else {
    const jar = parseCookieFile(raw);
    if (Object.keys(jar).length === 0) throw new CookieDeadError(`the cookie file at ${deps.cookieFile} is empty`);
    log.info(state.cookie ? "the cookie file changed; replacing the cookie jar" : "loaded the cookie jar from the cookie file", {
      cookies: Object.keys(jar).length,
    });
    state.cookie = { jar, sourceHash };
  }
  state.puuid = null;
  state.shard = null;
  state.flags.cookieDeadNotified = false;
  await deps.save(state);
}

export async function authenticate(deps: AuthDeps): Promise<Session> {
  const { state, http } = deps;
  await syncCookieSource(deps);
  // Spec: after a "cookie dead" alert, stop calling auth until the cookie file changes.
  if (state.flags.cookieDeadNotified) throw new CookieDeadError("the cookie is dead; waiting for a new cookie file");
  const cookie = state.cookie;
  if (!cookie) throw new CookieDeadError("no cookie jar");
  for (const value of Object.values(cookie.jar)) addSecret(value);

  // E1: reauth, without following the redirect.
  const e1 = await http.request(REAUTH_URL, { cookie: serializeJar(cookie.jar), headers: { "User-Agent": USER_AGENT } });
  const outcome = classifyReauth(e1.status, e1.headers);
  switch (outcome.kind) {
    case "rate-limited":
      throw new RateLimitedError("auth.riotgames.com", outcome.retryAfterSeconds);
    case "blocked":
      throw new CloudflareBlockedError(`E1 refused: ${outcome.reason}`);
    case "dead":
      throw new CookieDeadError(`Riot sent the reauth to its login page (${outcome.where})`);
  }

  // Step 3: keep Riot's rotated cookies before anything else can fail.
  const setCookies = e1.headers.getSetCookie();
  if (setCookies.length === 0) log.warn("reauth worked but Riot sent no Set-Cookie; the jar was not rotated");
  state.cookie = { jar: mergeSetCookies(cookie.jar, setCookies), sourceHash: cookie.sourceHash };
  for (const value of Object.values(state.cookie.jar)) addSecret(value);
  await deps.save(state);

  // Steps 4-6 (a new cookie file cleared the PUUID and shard, so they are fetched again).
  const { session, cacheChanged } = await completeSession(http, outcome, state, deps.shardOverride);
  if (cacheChanged) await deps.save(state);
  return session;
}

/** Where completeSession keeps the PUUID and shard between runs: the owner's state, or a member's record. */
export interface SessionCache {
  puuid: string | null;
  shard: string | null;
}

/**
 * Auth flow, steps 4-6, for any access and ID token, whether it came from the owner's cookie or a
 * member's refresh token: E2 and E3 every time, E4 only when the cache lacks the shard. E3 runs
 * every time because the Riot ID it returns is shown on shop posts and can change; the PUUID from it
 * is cached once. Fills the cache; the caller saves it when `cacheChanged`.
 */
export async function completeSession(
  http: Http,
  tokens: { accessToken: string; idToken: string },
  cache: SessionCache,
  shardOverride?: string,
): Promise<{ session: Session; cacheChanged: boolean; riotName: string | null }> {
  const { accessToken, idToken } = tokens;
  const bearer = { Authorization: `Bearer ${accessToken}` };
  const jsonHeaders = { ...bearer, "Content-Type": "application/json" };

  // E2: entitlements token.
  const e2 = await expectJson(await http.request(ENTITLEMENTS_URL, { method: "POST", headers: jsonHeaders }), "E2 entitlements");
  const entitlementsToken = text(e2.entitlements_token);
  if (!entitlementsToken) throw new UnexpectedResponseError("E2 entitlements: no entitlements_token");
  addSecret(entitlementsToken);

  let cacheChanged = false;
  const e3 = await expectJson(await http.request(USERINFO_URL, { headers: bearer }), "E3 userinfo");
  const puuid = text(e3.sub);
  if (!puuid) throw new UnexpectedResponseError("E3 userinfo: no sub (PUUID)");
  if (!cache.puuid) {
    cache.puuid = puuid;
    cacheChanged = true;
  }
  const acct = e3.acct as Record<string, unknown> | undefined;
  const gameName = text(acct?.game_name);
  const tagLine = text(acct?.tag_line);
  const riotName = gameName ? (tagLine ? `${gameName}#${tagLine}` : gameName) : null;
  let shard = shardOverride ?? cache.shard;
  if (!shard) {
    const e4 = await expectJson(
      await http.request(PAS_URL, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ id_token: idToken }) }),
      "E4 PAS",
    );
    const affinities = e4.affinities as Record<string, unknown> | undefined;
    const region = text(affinities?.live);
    if (!region) throw new UnexpectedResponseError("E4 PAS: no affinities.live");
    shard = regionToShard(region);
    cache.shard = shard;
    cacheChanged = true;
  }

  return { session: { accessToken, idToken, entitlementsToken, puuid: cache.puuid, shard, riotName }, cacheChanged, riotName };
}

async function expectJson(res: Response, what: string): Promise<Record<string, unknown>> {
  if (res.status === 429) throw new RateLimitedError(what, parseRetryAfter(res.headers.get("retry-after")));
  if (!res.ok) throw new UnexpectedResponseError(`${what} returned ${res.status}`);
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new UnexpectedResponseError(`${what} returned ${res.status} with a body that is not a JSON object`);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
