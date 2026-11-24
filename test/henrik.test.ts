import { expect, test } from "bun:test";
import { BUDGET_PER_MINUTE, createHenrik, HENRIK_BASE, HenrikAuthError, splitRiotId } from "../src/henrik.ts";
import type { Http } from "../src/http.ts";
import { RateLimitedError } from "../src/riot/auth.ts";

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fake HenrikDev with a fake clock: answers in order (the last one repeats); sleeping moves the clock. */
function fake(answers: Answer[]) {
  let t = 0;
  const sleeps: number[] = [];
  const calls: { url: string; auth: string | undefined }[] = [];
  const http: Http = {
    async request(url, options = {}) {
      calls.push({ url, auth: options.headers?.Authorization });
      const a = answers[Math.min(calls.length - 1, answers.length - 1)] as Answer;
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: a.headers ?? {} });
    },
  };
  const henrik = createHenrik({
    http,
    key: "HDEV-test-key-0000",
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { henrik, calls, sleeps, advance: (ms: number) => (t += ms) };
}

const PUUID = "p-friend";

test("splitRiotId: the tag is after the last #, names may have spaces", () => {
  expect(splitRiotId("john whiff#1TAP")).toEqual(["john whiff", "1TAP"]);
  expect(splitRiotId("a#b#c")).toEqual(["a#b", "c"]);
  expect(splitRiotId("nohash")).toEqual([null, null]);
  expect(splitRiotId("#tag")).toEqual([null, null]);
  expect(splitRiotId("name#")).toEqual([null, null]);
});

test("H1: a Riot ID resolves to PUUID and region, with the key in Authorization; unknown is null", async () => {
  const f = fake([{ status: 200, body: { data: { puuid: PUUID, name: "Friend", tag: "0003", region: "ap" } } }, { status: 404, body: { errors: [] } }]);
  expect(await f.henrik.account("Friend#0003")).toEqual({ puuid: PUUID, name: "Friend", tag: "0003", region: "ap" });
  expect(f.calls[0]).toEqual({ url: `${HENRIK_BASE}/valorant/v2/account/Friend/0003`, auth: "HDEV-test-key-0000" });
  expect(await f.henrik.account("Nobody#0000")).toBeNull();
  expect(await f.henrik.account("not an id")).toBeNull();
  expect(f.calls).toHaveLength(2);
});

test("H2: the newest match as a recap; no matches is null", async () => {
  const match = {
    metadata: { match_id: "m-1", map: { id: "x", name: "Ascent" }, queue: { id: "unrated" }, started_at: "2026-11-24T15:00:00.000Z", game_length_in_ms: 0, is_completed: true },
    players: [{ puuid: PUUID, name: "Friend", tag: "0003", team_id: "Red", agent: { id: "a" }, tier: { id: 0 }, stats: { score: 200, kills: 1, deaths: 1, assists: 0, headshots: 1, bodyshots: 1, legshots: 0, damage: { dealt: 150 } } }],
    teams: [],
    rounds: [{}],
  };
  const f = fake([{ status: 200, body: { data: [match] } }, { status: 200, body: { data: [] } }]);
  expect((await f.henrik.newestMatch("ap", PUUID))?.players[0]).toMatchObject({ acs: 200, hsPercent: 50, adr: 150 });
  expect(f.calls[0]?.url).toBe(`${HENRIK_BASE}/valorant/v4/by-puuid/matches/ap/pc/${PUUID}?size=1`);
  expect(await f.henrik.newestMatch("ap", PUUID)).toBeNull();
});

test("H3: RR change per match", async () => {
  const f = fake([{ status: 200, body: { data: { account: {}, history: [{ match_id: "m-1", last_change: -19, rr: 32, tier: { id: 6, name: "Bronze 1" }, tier_before_update: { id: 6 } }, { match_id: "m-0" }] } } }]);
  expect(await f.henrik.rrHistory("ap", PUUID)).toEqual([{ matchId: "m-1", earned: -19, after: 32, tierAfter: 6, tierBefore: 6 }]);
});

test("401 or 403 is an auth error: the key is missing or invalid", async () => {
  await expect(fake([{ status: 401 }]).henrik.account("A#1")).rejects.toBeInstanceOf(HenrikAuthError);
  await expect(fake([{ status: 403 }]).henrik.rrHistory("ap", PUUID)).rejects.toBeInstanceOf(HenrikAuthError);
});

test("429: waits Retry-After once and retries; a second 429 or a long wait ends the call", async () => {
  const ok = { status: 200, body: { data: { history: [] } } };
  const once = fake([{ status: 429, headers: { "retry-after": "30" } }, ok]);
  expect(await once.henrik.rrHistory("ap", PUUID)).toEqual([]);
  expect(once.sleeps).toContain(30_000);

  const twice = fake([{ status: 429, headers: { "retry-after": "5" } }]);
  await expect(twice.henrik.rrHistory("ap", PUUID)).rejects.toBeInstanceOf(RateLimitedError);
  await expect(fake([{ status: 429, headers: { "retry-after": "3600" } }]).henrik.rrHistory("ap", PUUID)).rejects.toBeInstanceOf(RateLimitedError);
});

test(`the budget: at most ${BUDGET_PER_MINUTE} units a minute, counting 3 per call until headers say otherwise`, async () => {
  const f = fake([{ status: 200, body: { data: { history: [] } } }]);
  for (let i = 0; i < 6; i++) await f.henrik.rrHistory("ap", PUUID); // 18 units
  expect(f.sleeps).toEqual([]);
  await f.henrik.rrHistory("ap", PUUID); // 21 > 20: waits for the next minute
  expect(f.sleeps).toEqual([60_000]);
});

test("HenrikDev's own headers win: few units left means waiting for its reset", async () => {
  const f = fake([
    { status: 200, body: { data: { history: [] } }, headers: { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "40" } },
    { status: 200, body: { data: { history: [] } }, headers: { "x-ratelimit-remaining": "29", "x-ratelimit-reset": "60" } },
  ]);
  await f.henrik.rrHistory("ap", PUUID);
  await f.henrik.rrHistory("ap", PUUID);
  expect(f.sleeps[0]).toBe(40_000);
});
