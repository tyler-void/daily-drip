// A synthetic E11 match built on the field names spike S2 confirmed. No real players' data.

import { expect, test } from "bun:test";
import { recapFromMatchDetails, teamByAcs, teamResult } from "../src/recap.ts";

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";
const C = "cccccccc-0000-0000-0000-00000000000c";
const D = "dddddddd-0000-0000-0000-00000000000d";

/** Two rounds; A and B on Blue, C and D on Red. */
function match(overrides: Record<string, unknown> = {}) {
  return {
    matchInfo: {
      matchId: "m-1",
      mapId: "/Game/Maps/Ascent/Ascent",
      queueID: "competitive",
      gameStartMillis: Date.parse("2026-11-24T15:00:00Z"),
      gameLengthMillis: 38 * 60_000 + 20_000,
      isCompleted: true,
    },
    players: [
      { subject: A, gameName: "Tyler", tagLine: "0001", teamId: "Blue", partyId: "p1", characterId: "ADD6443A-41BD-E414-F6AD-E58D267F4E95", competitiveTier: 13, stats: { score: 540, roundsPlayed: 2, kills: 4, deaths: 1, assists: 1 } },
      { subject: B, gameName: "Friend", tagLine: "0002", teamId: "Blue", partyId: "p1", characterId: "x-sova", competitiveTier: 12, stats: { score: 301, roundsPlayed: 2, kills: 2, deaths: 2, assists: 3 } },
      { subject: C, gameName: "Rando", tagLine: "0003", teamId: "Red", partyId: "p2", characterId: "x-raze", competitiveTier: 0, stats: { score: 400, roundsPlayed: 2, kills: 3, deaths: 3, assists: 0 } },
      // Riot sometimes sends no stats (valapidocs).
      { subject: D, gameName: "Ghost", tagLine: "0004", teamId: "Red", partyId: "p3", characterId: "x-omen", competitiveTier: 0, stats: null },
    ],
    teams: [
      { teamId: "Red", won: false, roundsWon: 9, roundsPlayed: 22 },
      { teamId: "Blue", won: true, roundsWon: 13, roundsPlayed: 22 },
    ],
    roundResults: [
      {
        playerStats: [
          // A: two damage entries in round 1.
          { subject: A, damage: [ { receiver: C, damage: 150, headshots: 1, bodyshots: 2, legshots: 0 }, { receiver: D, damage: 100, headshots: 0, bodyshots: 1, legshots: 1 } ] },
          { subject: C, damage: [{ receiver: A, damage: 80, headshots: 0, bodyshots: 3, legshots: 0 }] },
          { subject: B, damage: [] },
        ],
      },
      { playerStats: [{ subject: A, damage: [{ receiver: C, damage: 74, headshots: 1, bodyshots: 0, legshots: 0 }] }] },
    ],
    ...overrides,
  };
}

test("match info: id, map, queue (Riot's queueID key), start, length in minutes, completed, rounds", () => {
  const r = recapFromMatchDetails(match());
  expect(r).toMatchObject({ matchId: "m-1", mapId: "/Game/Maps/Ascent/Ascent", queue: "competitive", startedAt: "2026-11-24T15:00:00.000Z", lengthMinutes: 38, completed: true, rounds: 2 });
  expect(r?.teams).toEqual([
    { teamId: "Red", won: false, roundsWon: 9 },
    { teamId: "Blue", won: true, roundsWon: 13 },
  ]);
});

test("the spec's formulas: ACS = score/rounds, HS% over every damage entry, ADR = damage/rounds", () => {
  const a = recapFromMatchDetails(match())?.players.find((p) => p.puuid === A);
  // ACS 540/2 = 270. Shots: head 1+0+1 = 2, body 2+1+0 = 3, leg 0+1+0 = 1 -> 2/6 = 33%. Damage 324/2 = 162.
  expect(a).toEqual({
    puuid: A,
    riotName: "Tyler#0001",
    teamId: "Blue",
    partyId: "p1",
    agentId: "add6443a-41bd-e414-f6ad-e58d267f4e95",
    tier: 13,
    kills: 4,
    deaths: 1,
    assists: 1,
    acs: 270,
    hsPercent: 33,
    adr: 162,
  });
});

test("no damage entries: HS% unknown, ADR 0; no stats at all: K/D/A and ACS unknown", () => {
  const r = recapFromMatchDetails(match());
  expect(r?.players.find((p) => p.puuid === B)).toMatchObject({ acs: 151, hsPercent: null, adr: 0 });
  expect(r?.players.find((p) => p.puuid === D)).toMatchObject({ kills: null, deaths: null, assists: null, acs: null, hsPercent: null, adr: null });
});

test("a match Riot is still processing is marked not completed", () => {
  const m = match();
  m.matchInfo.isCompleted = false;
  expect(recapFromMatchDetails(m)?.completed).toBe(false);
});

test("anything that isn't a match gives null", () => {
  expect(recapFromMatchDetails(null)).toBeNull();
  expect(recapFromMatchDetails({ errorCode: "RESOURCE_NOT_FOUND" })).toBeNull();
  expect(recapFromMatchDetails({ matchInfo: { matchId: "m" }, players: [] })).toBeNull();
});

test("team result for the tracked players: victory, defeat, draw, split, or none tracked", () => {
  const r = recapFromMatchDetails(match())!;
  expect(teamResult(r, [A, B])).toEqual({ kind: "victory", teamId: "Blue", score: "13–9" });
  expect(teamResult(r, [C])).toEqual({ kind: "defeat", teamId: "Red", score: "9–13" });
  expect(teamResult(r, [A, C])).toEqual({ kind: "split", score: "9–13" });
  expect(teamResult(r, ["nobody"])).toBeNull();
  const draw = recapFromMatchDetails(match({ teams: [ { teamId: "Red", won: false, roundsWon: 12 }, { teamId: "Blue", won: false, roundsWon: 12 } ] }))!;
  expect(teamResult(draw, [A])).toEqual({ kind: "draw", teamId: "Blue", score: "12–12" });
});

test("a team's players sorted by ACS, those without stats last", () => {
  const r = recapFromMatchDetails(match())!;
  expect(teamByAcs(r, "Blue").map((p) => p.puuid)).toEqual([A, B]);
  expect(teamByAcs(r, "Red").map((p) => p.puuid)).toEqual([C, D]);
});
