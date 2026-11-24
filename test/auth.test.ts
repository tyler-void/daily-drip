import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCookieFile } from "../src/cookies.ts";
import type { Http } from "../src/http.ts";
import {
  authenticate,
  classifyReauth,
  CloudflareBlockedError,
  CookieDeadError,
  ENTITLEMENTS_URL,
  PAS_URL,
  parseRetryAfter,
  parseTokenFragment,
  RateLimitedError,
  REAUTH_URL,
  regionToShard,
  UnexpectedResponseError,
  USERINFO_URL,
  type AuthDeps,
} from "../src/riot/auth.ts";
import { emptyState, type State } from "../src/state.ts";
import { fakeRiot, headers, OK_LOCATION } from "./fakes.ts";

describe("classifyReauth", () => {
  test("303 with tokens in the fragment is ok", () => {
    expect(classifyReauth(303, headers({ location: OK_LOCATION }))).toEqual({ kind: "ok", accessToken: "AT", idToken: "IT" });
  });

  test("a redirect to authenticate.riotgames.com/login means the cookie is dead", () => {
    const out = classifyReauth(303, headers({ location: "https://authenticate.riotgames.com/login?client_id=x" }));
    expect(out).toEqual({ kind: "dead", where: "authenticate.riotgames.com/login" });
  });

  test("SkinPeek's relative /login also means the cookie is dead", () => {
    expect(classifyReauth(303, headers({ location: "/login?x=1" })).kind).toBe("dead");
  });

  test("403 with x-frame-options SAMEORIGIN is a Cloudflare block", () => {
    const out = classifyReauth(403, headers({ "x-frame-options": "SAMEORIGIN" }));
    expect(out).toEqual({ kind: "blocked", reason: "403 with x-frame-options: SAMEORIGIN (Cloudflare)" });
  });

  test("a redirect without tokens is treated as a block, without leaking the query", () => {
    const out = classifyReauth(303, headers({ location: "https://playvalorant.com/opt_in?secret=1" }));
    expect(out.kind).toBe("blocked");
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  test("429 reads Retry-After", () => {
    expect(classifyReauth(429, headers({ "retry-after": "120" }))).toEqual({ kind: "rate-limited", retryAfterSeconds: 120 });
  });
});

test("parseTokenFragment needs both tokens", () => {
  expect(parseTokenFragment(OK_LOCATION)).toEqual({ accessToken: "AT", idToken: "IT" });
  expect(parseTokenFragment("https://playvalorant.com/opt_in#access_token=AT")).toBeNull();
  expect(parseTokenFragment("https://playvalorant.com/opt_in")).toBeNull();
});

test("parseRetryAfter reads seconds or a date, and defaults to 1 h", () => {
  const now = Date.parse("2026-11-23T00:00:00Z");
  expect(parseRetryAfter("30", now)).toBe(30);
  expect(parseRetryAfter("Mon, 23 Nov 2026 00:10:00 GMT", now)).toBe(600);
  expect(parseRetryAfter(null, now)).toBe(3600);
  expect(parseRetryAfter("soon", now)).toBe(3600);
});

test("regionToShard maps latam and br to na", () => {
  expect(regionToShard("latam")).toBe("na");
  expect(regionToShard("br")).toBe("na");
  expect(regionToShard("ap")).toBe("ap");
});

// ---------- authenticate() against a fake Riot ----------

let dir: string;
let cookieFile: string;
let saved: State[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daily-drip-auth-"));
  cookieFile = join(dir, "riot-cookie");
  await writeFile(cookieFile, "ssid=original; clid=c1");
  saved = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(http: Http, state: State = emptyState(), extra: Partial<AuthDeps> = {}): AuthDeps {
  return {
    http,
    state,
    save: async (s) => {
      saved.push(structuredClone(s));
    },
    cookieFile,
    spikeJarFile: join(dir, "no-spike-jar.json"),
    ...extra,
  };
}

describe("authenticate", () => {
  test("happy path: rotates and saves the jar, then fetches entitlements, PUUID and shard", async () => {
    const { http, calls } = fakeRiot();
    const state = emptyState();
    const session = await authenticate(deps(http, state));

    expect(session).toEqual({ accessToken: "AT", idToken: "IT", entitlementsToken: "ENT", puuid: "puuid-1234-5678", shard: "ap", riotName: null });
    expect(calls.map((c) => c.url)).toEqual([REAUTH_URL, ENTITLEMENTS_URL, USERINFO_URL, PAS_URL]);
    expect(calls[0]?.options.cookie).toBe("ssid=original; clid=c1");
    expect(calls[0]?.options.headers?.["User-Agent"]).toStartWith("ShooterGame/");
    expect(state.cookie?.jar).toEqual({ ssid: "rotated", clid: "c1", ccid: "new" });
    expect(state.puuid).toBe("puuid-1234-5678");
    expect(state.shard).toBe("ap");
  });

  test("the rotated jar is saved even when a later step fails", async () => {
    const { http } = fakeRiot({ [ENTITLEMENTS_URL]: () => new Response("oops", { status: 500 }) });
    const state = emptyState();
    await expect(authenticate(deps(http, state))).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(saved.at(-1)?.cookie?.jar.ssid).toBe("rotated");
  });

  test("a second run reuses the cached shard; E3 runs again for the current Riot ID", async () => {
    const first = fakeRiot();
    const state = emptyState();
    await authenticate(deps(first.http, state));

    const second = fakeRiot();
    await authenticate(deps(second.http, state));
    expect(second.calls.map((c) => c.url)).toEqual([REAUTH_URL, ENTITLEMENTS_URL, USERINFO_URL]);
    expect(second.calls[0]?.options.cookie).toBe("ssid=rotated; clid=c1; ccid=new");
  });

  test("RIOT_SHARD skips E4", async () => {
    const { http, calls } = fakeRiot();
    const session = await authenticate(deps(http, emptyState(), { shardOverride: "na" }));
    expect(session.shard).toBe("na");
    expect(calls.map((c) => c.url)).not.toContain(PAS_URL);
  });

  test("a new cookie file replaces the jar and clears the caches and the dead flag", async () => {
    const state = emptyState();
    state.cookie = { jar: { ssid: "old-rotated" }, sourceHash: hashCookieFile("ssid=old") };
    state.puuid = "someone-else";
    state.shard = "eu";
    state.flags.cookieDeadNotified = true;

    const { http, calls } = fakeRiot();
    const session = await authenticate(deps(http, state));
    expect(calls[0]?.options.cookie).toBe("ssid=original; clid=c1");
    expect(session.puuid).toBe("puuid-1234-5678");
    expect(session.shard).toBe("ap");
    expect(state.flags.cookieDeadNotified).toBe(false);
  });

  test("a login redirect is CookieDeadError and leaves the jar alone", async () => {
    const { http } = fakeRiot({
      [REAUTH_URL]: () => new Response(null, { status: 303, headers: headers({ location: "https://authenticate.riotgames.com/login" }, ["asid=anon"]) }),
    });
    const state = emptyState();
    await expect(authenticate(deps(http, state))).rejects.toBeInstanceOf(CookieDeadError);
    expect(state.cookie?.jar).toEqual({ ssid: "original", clid: "c1" });
  });

  test("after a cookie-dead alert, Riot is not called until the cookie file changes", async () => {
    const state = emptyState();
    state.cookie = { jar: { ssid: "dead" }, sourceHash: hashCookieFile("ssid=original; clid=c1") };
    state.flags.cookieDeadNotified = true;
    const { http, calls } = fakeRiot();
    await expect(authenticate(deps(http, state))).rejects.toBeInstanceOf(CookieDeadError);
    expect(calls).toHaveLength(0);
  });

  test("a Cloudflare 403 is CloudflareBlockedError", async () => {
    const { http } = fakeRiot({ [REAUTH_URL]: () => new Response("blocked", { status: 403, headers: { "x-frame-options": "SAMEORIGIN" } }) });
    await expect(authenticate(deps(http))).rejects.toBeInstanceOf(CloudflareBlockedError);
  });

  test("a 429 on E1 is RateLimitedError with Retry-After", async () => {
    const { http } = fakeRiot({ [REAUTH_URL]: () => new Response(null, { status: 429, headers: { "retry-after": "90" } }) });
    const err = await authenticate(deps(http)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(90);
  });

  test("no cookie file and no saved jar is CookieDeadError", async () => {
    const { http, calls } = fakeRiot();
    await expect(authenticate(deps(http, emptyState(), { cookieFile: join(dir, "missing") }))).rejects.toBeInstanceOf(CookieDeadError);
    expect(calls).toHaveLength(0);
  });

  test("a missing cookie file is fine while a saved jar exists", async () => {
    const state = emptyState();
    state.cookie = { jar: { ssid: "saved" }, sourceHash: "whatever" };
    const { http, calls } = fakeRiot();
    await authenticate(deps(http, state, { cookieFile: join(dir, "missing") }));
    expect(calls[0]?.options.cookie).toBe("ssid=saved");
  });

  test("an empty cookie file is CookieDeadError", async () => {
    await writeFile(cookieFile, "\n");
    const { http } = fakeRiot();
    await expect(authenticate(deps(http))).rejects.toBeInstanceOf(CookieDeadError);
  });

  test("the spike's rotated jar is imported on the first run", async () => {
    const spikeJarFile = join(dir, "spike-jar.json");
    await writeFile(spikeJarFile, JSON.stringify({ sourceHash: hashCookieFile("ssid=original; clid=c1"), jar: { ssid: "from-spike", clid: "c1" } }));
    const { http, calls } = fakeRiot();
    await authenticate(deps(http, emptyState(), { spikeJarFile }));
    expect(calls[0]?.options.cookie).toBe("ssid=from-spike; clid=c1");
  });
});
