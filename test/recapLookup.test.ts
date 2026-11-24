import { expect, test } from "bun:test";
import type { Henrik } from "../src/henrik.ts";
import { nthMatch, type Person, playerChoices, resolvePlayer } from "../src/recapLookup.ts";
import type { MatchRecap } from "../src/recap.ts";
import type { PdApi } from "../src/recapPoll.ts";
import { LoginDeadError } from "../src/riot/login.ts";

const people: Person[] = [
  { discordUserId: "1", discordUsername: "tyler", riotName: "john whiff#1TAP", puuid: "p1", linked: true, region: null },
  { discordUserId: "2", discordUsername: ".k.huy", riotName: "NIRAN#4811", puuid: "p2", linked: true, region: null },
  { discordUserId: "3", discordUsername: "friendo", riotName: "Friend#0003", puuid: "p3", linked: false, region: "ap" },
];
const henrik: Henrik = {
  account: async (id) => (id === "Other#1234" ? { puuid: "p9", name: "Other", tag: "1234", region: "eu" } : null),
  newestMatch: async () => null,
  matches: async () => [],
  rrHistory: async () => [],
};

test("autocomplete: people the bot knows by Discord or Riot name, labelled with both; a typed Riot ID to look up", () => {
  expect(playerChoices(people, "")).toEqual([
    { name: ".k.huy (NIRAN#4811)", value: "user:2" },
    { name: "friendo (Friend#0003)", value: "user:3" },
    { name: "tyler (john whiff#1TAP)", value: "user:1" },
  ]);
  expect(playerChoices(people, "niran")).toEqual([{ name: ".k.huy (NIRAN#4811)", value: "user:2" }]);
  expect(playerChoices(people, "Other#1234")).toEqual([{ name: "Look up Other#1234", value: "riot:Other#1234" }]);
  // A Riot ID the bot already knows isn't offered as a lookup.
  expect(playerChoices(people, "Friend#0003").map((c) => c.value)).toEqual(["user:3"]);
});

test("resolvePlayer: empty is the caller; autocomplete values; Riot IDs, known or looked up; Discord usernames", async () => {
  expect(await resolvePlayer("", "2", people, henrik)).toMatchObject({ ok: true, value: { kind: "person", person: { discordUserId: "2" } } });
  expect(await resolvePlayer("user:3", "1", people, henrik)).toMatchObject({ ok: true, value: { person: { riotName: "Friend#0003" } } });
  expect(await resolvePlayer("niran#4811", "1", people, henrik)).toMatchObject({ ok: true, value: { person: { discordUserId: "2" } } });
  expect(await resolvePlayer("riot:Other#1234", "1", people, henrik)).toMatchObject({ ok: true, value: { kind: "riot", account: { puuid: "p9", region: "eu" } } });
  expect(await resolvePlayer("@friendo", "1", people, henrik)).toMatchObject({ ok: true, value: { person: { discordUserId: "3" } } });
  expect(await resolvePlayer("huy", "1", people, henrik)).toMatchObject({ ok: true, value: { person: { discordUserId: "2" } } });
});

test("resolvePlayer refuses what it can't place", async () => {
  expect((await resolvePlayer("", "99", people, henrik)).ok).toBe(false);
  expect((await resolvePlayer("Nobody#0000", "1", people, henrik)).ok).toBe(false);
  expect((await resolvePlayer("Other#1234", "1", people, null)).ok).toBe(false); // no HenrikDev key
  expect((await resolvePlayer("zzz", "1", people, henrik)).ok).toBe(false);
  expect(await resolvePlayer("r", "1", people, henrik)).toMatchObject({ ok: false, reason: expect.stringContaining("matches 2 people") });
});

test("a linked person whose sign-in is dead is read through HenrikDev; without HenrikDev the error stands", async () => {
  const dead: PdApi = {
    session: async () => { throw new LoginDeadError("the refresh: the sign-in is no longer valid"); },
    dropSession: () => {},
    history: async () => [],
    details: async () => { throw new Error("unused"); },
    rr: async () => [],
  };
  const match = { matchId: "m1", queue: "unrated" } as MatchRecap;
  const viaHenrik: Henrik = { ...henrik, matches: async (region, puuid, n) => (region === "ap" && puuid === "p2" && n === 1 ? [match] : []) };
  const target = { kind: "person" as const, person: people[1]! };
  expect(await nthMatch(target, 1, { pd: dead, henrik: viaHenrik })).toEqual({ ok: true, value: { recap: match, puuid: "p2", rr: {} } });
  await expect(nthMatch(target, 1, { pd: dead, henrik: null })).rejects.toBeInstanceOf(LoginDeadError);
});
