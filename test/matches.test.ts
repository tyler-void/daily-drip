import { expect, test } from "bun:test";
import type { Http, RequestOptions } from "../src/http.ts";
import { RateLimitedError, type Session, UnexpectedResponseError } from "../src/riot/auth.ts";
import {
  competitiveUpdatesUrl,
  detailsUrl,
  fetchHistory,
  fetchMatchDetails,
  fetchRrUpdates,
  historyUrl,
  MatchNotReadyError,
  nameServiceUrl,
} from "../src/riot/matches.ts";
import { BadClaimsError, MaintenanceError } from "../src/riot/store.ts";

const session: Session = { accessToken: "AT", idToken: "IT", entitlementsToken: "ENT", puuid: "p-owner", shard: "ap", riotName: null };
const VERSION = "release-13.10-shipping-1";

function http(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; options: RequestOptions }[] = [];
  const h: Http = {
    async request(url, options = {}) {
      calls.push({ url, options });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
    },
  };
  return { http: h, calls };
}

test("URLs: history and RR for a PUUID, details for a match, on the session's shard", () => {
  expect(historyUrl(session, "p-x")).toBe("https://pd.ap.a.pvp.net/match-history/v1/history/p-x?startIndex=0&endIndex=5");
  expect(detailsUrl(session, "m-1")).toBe("https://pd.ap.a.pvp.net/match-details/v1/matches/m-1");
  expect(competitiveUpdatesUrl(session, "p-owner")).toBe("https://pd.ap.a.pvp.net/mmr/v1/players/p-owner/competitiveupdates?startIndex=0&endIndex=5&queue=competitive");
});

test("E10 lists matches newest first with start time and queue, sending the 4 game headers", async () => {
  const fake = http(200, { History: [{ MatchID: "m-2", GameStartTime: Date.parse("2026-11-24T16:04:18Z"), QueueID: "unrated" }, { MatchID: "m-1", GameStartTime: 0, QueueID: "" }, { nope: 1 }] });
  expect(await fetchHistory(fake.http, session, VERSION)).toEqual([
    { matchId: "m-2", startedAt: "2026-11-24T16:04:18.000Z", queue: "unrated" },
    { matchId: "m-1", startedAt: "1970-01-01T00:00:00.000Z", queue: "" },
  ]);
  const h = fake.calls[0]?.options.headers ?? {};
  expect(h.Authorization).toBe("Bearer AT");
  expect(h["X-Riot-Entitlements-JWT"]).toBe("ENT");
  expect(h["X-Riot-ClientVersion"]).toBe(VERSION);
  expect(h["X-Riot-ClientPlatform"]).toBeTruthy();
});

test("E11 parses into a recap; something that isn't a match is an error", async () => {
  const match = {
    matchInfo: { matchId: "m-1", mapId: "/Game/Maps/Ascent/Ascent", queueID: "competitive", isCompleted: true, gameStartMillis: 0, gameLengthMillis: 0 },
    players: [{ subject: "p-owner", teamId: "Blue", characterId: "x", competitiveTier: 3, stats: { score: 100, roundsPlayed: 1, kills: 1, deaths: 0, assists: 0 } }],
    teams: [],
    roundResults: [],
  };
  expect((await fetchMatchDetails(http(200, match).http, session, VERSION, "m-1")).matchId).toBe("m-1");
  await expect(fetchMatchDetails(http(200, { foo: 1 }).http, session, VERSION, "m-1")).rejects.toBeInstanceOf(UnexpectedResponseError);
});

test("E12 gives the RR change per match", async () => {
  const fake = http(200, { Matches: [{ MatchID: "m-1", RankedRatingEarned: -18, RankedRatingAfterUpdate: 42, TierAfterUpdate: 12, TierBeforeUpdate: 12 }, { MatchID: "m-0" }] });
  expect(await fetchRrUpdates(fake.http, session, VERSION)).toEqual([{ matchId: "m-1", earned: -18, after: 42, tierAfter: 12, tierBefore: 12 }]);
});

test("errors: 401 and BAD_CLAIMS are stale sessions, 404 is not ready yet, 429 a rate limit, downtime is maintenance", async () => {
  await expect(fetchHistory(http(401, {}).http, session, VERSION)).rejects.toBeInstanceOf(BadClaimsError);
  await expect(fetchHistory(http(400, { errorCode: "BAD_CLAIMS" }).http, session, VERSION)).rejects.toBeInstanceOf(BadClaimsError);
  await expect(fetchMatchDetails(http(404, { errorCode: "RESOURCE_NOT_FOUND" }).http, session, VERSION, "m-1")).rejects.toBeInstanceOf(MatchNotReadyError);
  await expect(fetchHistory(http(429, {}, { "retry-after": "60" }).http, session, VERSION)).rejects.toBeInstanceOf(RateLimitedError);
  await expect(fetchHistory(http(503, { errorCode: "SCHEDULED_DOWNTIME" }).http, session, VERSION)).rejects.toBeInstanceOf(MaintenanceError);
  await expect(fetchHistory(http(500, "oops").http, session, VERSION)).rejects.toBeInstanceOf(UnexpectedResponseError);
});

test("E11's blank names are filled from the name service (E13); if it fails, the recap still comes back", async () => {
  const match = {
    matchInfo: { matchId: "m-1", mapId: "/Game/Maps/Ascent/Ascent", queueID: "unrated", isCompleted: true, gameStartMillis: 0, gameLengthMillis: 0 },
    players: ["p-owner", "p-mate", "p-hidden"].map((subject) => ({ subject, gameName: "", tagLine: "", teamId: "Blue", characterId: "x", competitiveTier: 3, stats: { score: 100, roundsPlayed: 1, kills: 1, deaths: 0, assists: 0 } })),
    teams: [],
    roundResults: [],
  };
  const calls: { url: string; options: RequestOptions }[] = [];
  const routed = (names: number): Http => ({
    async request(url, options = {}) {
      calls.push({ url, options });
      if (url === nameServiceUrl(session)) {
        const list = [
          { Subject: "p-owner", GameName: "Tyler", TagLine: "0001" },
          { Subject: "p-mate", GameName: "Mate", TagLine: "VN2" },
          { Subject: "p-hidden", GameName: "", TagLine: "" },
        ];
        return new Response(JSON.stringify(list), { status: names });
      }
      return new Response(JSON.stringify(match), { status: 200 });
    },
  });
  const recap = await fetchMatchDetails(routed(200), session, VERSION, "m-1");
  expect(recap.players.map((p) => p.riotName)).toEqual(["Tyler#0001", "Mate#VN2", null]);
  const put = calls.find((c) => c.url === nameServiceUrl(session))!;
  expect(put.options.method).toBe("PUT");
  expect(JSON.parse(put.options.body!)).toEqual(["p-owner", "p-mate", "p-hidden"]);
  expect(put.options.headers?.["X-Riot-Entitlements-JWT"]).toBe("ENT");
  const without = await fetchMatchDetails(routed(500), session, VERSION, "m-1");
  expect(without.players.map((p) => p.riotName)).toEqual([null, null, null]);
});
