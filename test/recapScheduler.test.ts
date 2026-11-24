import { expect, test } from "bun:test";
import { CloudflareBlockedError, RateLimitedError } from "../src/riot/auth.ts";
import { createRecapScheduler, isPlayingValorant, type PollOptions } from "../src/recapScheduler.ts";
import type { RosterEntry } from "../src/roster.ts";

const MIN = 60_000;
// 10:00 local on day 1; the sweep hour is 04:00.
const T0 = 10 * 60 * MIN;
const DAY = 24 * 60 * MIN;

const entry = (id: string, tier: RosterEntry["tier"] = "linked", trigger: RosterEntry["trigger"] = "presence"): RosterEntry => ({
  discordUserId: id,
  tier,
  enabled: true,
  trigger,
  puuid: `p-${id}`,
  riotName: `${id}#1`,
  region: tier === "followed" ? "ap" : null,
  addedAt: "",
});

function setup(entries: RosterEntry[], poll?: (e: RosterEntry, o: PollOptions) => Promise<void>) {
  let t = T0;
  const polls: string[] = [];
  const s = createRecapScheduler({
    entries: () => entries,
    sourceOf: (e) => (e.tier === "followed" ? "henrik" : "pd"),
    poll: async (e, o) => {
      polls.push(`${e.discordUserId}${o.sweep ? ":sweep" : ""}`);
      await poll?.(e, o);
    },
    now: () => t,
    localHour: (ms) => Math.floor((ms % DAY) / (60 * MIN)),
    localDay: (ms) => `day${Math.floor(ms / DAY)}`,
  });
  return { s, polls, at: async (ms: number) => { t = ms; await s.tick(); } };
}

test("nobody playing: no polls at all", async () => {
  const x = setup([entry("a"), entry("b")]);
  for (let m = 0; m <= 120; m += 1) await x.at(T0 + m * MIN);
  expect(x.polls).toEqual([]);
});

test("while playing: a poll every 4 minutes", async () => {
  const x = setup([entry("a")]);
  x.s.presence("a", true);
  for (let m = 0; m <= 13; m += 1) await x.at(T0 + m * MIN);
  expect(x.polls).toEqual(["a", "a", "a"]); // at 4, 8 and 12 min
});

test("after stopping: polls at +2, +5 and +10 minutes, then nothing", async () => {
  const x = setup([entry("a")]);
  x.s.presence("a", true);
  await x.at(T0 + 1 * MIN);
  x.s.presence("a", false);
  for (let m = 1; m <= 40; m += 1) await x.at(T0 + m * MIN);
  expect(x.polls).toEqual(["a", "a", "a"]);
  expect(x.s.status("a")).toEqual({ playing: false, nextPollAt: null, afterStop: [] });
});

test("repeated presence updates with the same state change nothing", async () => {
  const x = setup([entry("a")]);
  x.s.presence("a", true);
  const first = x.s.status("a").nextPollAt;
  x.s.presence("a", true);
  expect(x.s.status("a").nextPollAt).toBe(first);
});

test("'poll' entries poll every 20 minutes and ignore presence; unknown or off people are ignored", async () => {
  const x = setup([entry("a", "followed", "poll")]);
  x.s.presence("a", true);
  x.s.presence("stranger", true);
  for (let m = 0; m <= 61; m += 1) await x.at(T0 + m * MIN);
  expect(x.polls).toEqual(["a", "a", "a"]); // at 20, 40 and 60 min
});

test("the sweep runs once a day at 04:00 for everyone, marked as a sweep", async () => {
  const x = setup([entry("a"), entry("b", "followed")]);
  await x.at(T0); // started at 10:00: today's sweep counts as done
  await x.at(DAY + 3 * 60 * MIN);
  expect(x.polls).toEqual([]);
  await x.at(DAY + 4 * 60 * MIN);
  await x.at(DAY + 5 * 60 * MIN);
  expect(x.polls).toEqual(["a:sweep", "b:sweep"]);
});

test("a rate limit pauses that source only, for Retry-After; Cloudflare for an hour", async () => {
  const x = setup([entry("a"), entry("b", "followed")], async (e) => {
    if (e.discordUserId === "a") throw new RateLimitedError("E10", 600);
  });
  x.s.presence("a", true);
  x.s.presence("b", true);
  await x.at(T0 + 4 * MIN);
  expect(x.s.pausedUntil("pd")).toBe(T0 + 4 * MIN + 600_000);
  expect(x.s.pausedUntil("henrik")).toBe(0);
  await x.at(T0 + 8 * MIN);
  expect(x.polls).toEqual(["a", "b", "b"]); // a is paused; b keeps going

  const cf = setup([entry("c")], async () => {
    throw new CloudflareBlockedError("403");
  });
  cf.s.presence("c", true);
  await cf.at(T0 + 4 * MIN);
  expect(cf.s.pausedUntil("pd")).toBe(T0 + 4 * MIN + 60 * MIN);
});

test("other poll errors don't stop the schedule", async () => {
  const x = setup([entry("a")], async () => {
    throw new Error("E11 returned 500");
  });
  x.s.presence("a", true);
  await x.at(T0 + 4 * MIN);
  await x.at(T0 + 8 * MIN);
  expect(x.polls).toEqual(["a", "a"]);
});

test("isPlayingValorant: a Playing activity named VALORANT, any case", () => {
  expect(isPlayingValorant([{ type: 0, name: "VALORANT" }])).toBe(true);
  expect(isPlayingValorant([{ type: 4, name: "Custom Status" }, { type: 0, name: "valorant " }])).toBe(true);
  expect(isPlayingValorant([{ type: 2, name: "VALORANT" }])).toBe(false); // listening, not playing
  expect(isPlayingValorant([{ type: 0, name: "VALORANT Tracker" }])).toBe(false);
  expect(isPlayingValorant(null)).toBe(false);
});
