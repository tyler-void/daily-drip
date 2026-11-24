import { expect, test } from "bun:test";
import type { Henrik } from "../src/henrik.ts";
import type { DiscordMessage } from "../src/notify/discord.ts";
import type { MatchRecap, RecapPlayer } from "../src/recap.ts";
import { createRecapPoller, GIVE_UP_NOT_READY_MS, GIVE_UP_RR_MS, type PdApi } from "../src/recapPoll.ts";
import type { Session } from "../src/riot/auth.ts";
import { type HistoryEntry, MatchNotReadyError, type RrUpdate } from "../src/riot/matches.ts";
import { BadClaimsError } from "../src/riot/store.ts";
import { join, type Roster, turnOn } from "../src/roster.ts";
import { emptyRecapState, type RecapState } from "../src/state.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-25T12:00:00Z");
const OWNER = "100000000000000001";
const MEMBER = "200000000000000002";
const FRIEND = "300000000000000003";

const player = (puuid: string, teamId = "Blue"): RecapPlayer => ({
  puuid, riotName: `${puuid}#1`, teamId, partyId: null, agentId: "x", tier: 13, kills: 10, deaths: 5, assists: 2, acs: 200, hsPercent: 20, adr: 140,
});
const match = (id: string, queue = "competitive", completed = true, startedAt = new Date(T0 - 40 * MIN).toISOString()): MatchRecap => ({
  matchId: id, mapId: "/Game/Maps/Ascent/Ascent", queue, startedAt, lengthMinutes: 35, completed, rounds: 22,
  teams: [{ teamId: "Blue", won: true, roundsWon: 13 }, { teamId: "Red", won: false, roundsWon: 9 }],
  players: [player("p-owner"), player("p-member"), player("p-friend", "Red"), player("p-rando", "Red")],
});
const hist = (m: MatchRecap): HistoryEntry => ({ matchId: m.matchId, startedAt: m.startedAt, queue: m.queue });
const session = (puuid: string, n = 1): Session => ({ accessToken: `AT${n}`, idToken: "", entitlementsToken: "", puuid, shard: "ap", riotName: null });

function rosterWithOwnerAndMember(): Roster {
  const roster: Roster = {};
  turnOn(roster, OWNER, { kind: "owner", puuid: "p-owner" }, "Owner#1", new Date(T0 - 60 * MIN));
  turnOn(roster, MEMBER, { kind: "member", puuid: "p-member" }, "Member#1", new Date(T0 - 60 * MIN));
  return roster;
}

/** Fake Riot pd: per-PUUID history, match details and RR, with switches for the failure paths. */
function fakePd(opts: { matches: MatchRecap[]; rr?: Record<string, RrUpdate[]> }) {
  const calls: string[] = [];
  let staleOnce = false;
  let sessions = 0;
  const pd: PdApi & { staleOnce(): void; calls: string[] } = {
    calls,
    staleOnce: () => (staleOnce = true),
    async session(entry) {
      calls.push(`session:${entry.puuid}`);
      return session(entry.puuid, ++sessions);
    },
    dropSession(entry) {
      calls.push(`drop:${entry.puuid}`);
    },
    async history(s) {
      calls.push(`history:${s.puuid}`);
      if (staleOnce) {
        staleOnce = false;
        throw new BadClaimsError("E10: 401");
      }
      return opts.matches.filter((m) => m.players.some((p) => p.puuid === s.puuid)).map(hist);
    },
    async details(_s, id) {
      const m = opts.matches.find((x) => x.matchId === id);
      if (!m) throw new MatchNotReadyError("E11: 404");
      return m;
    },
    async rr(s) {
      return opts.rr?.[s.puuid] ?? [];
    },
  };
  return pd;
}

function setup(roster: Roster, pd: PdApi | null, henrik: Henrik | null = null) {
  let t = T0;
  const recap: RecapState = { ...emptyRecapState(), roster };
  const posts: DiscordMessage[] = [];
  const edits: { id: string; message: DiscordMessage }[] = [];
  const poller = createRecapPoller({
    recap,
    save: async () => {},
    queues: ["competitive", "unrated", "swiftplay"],
    names: () => null,
    pd,
    henrik,
    post: async (m) => {
      posts.push(m);
      return `msg-${posts.length}`;
    },
    edit: async (id, message) => void edits.push({ id, message }),
    now: () => t,
  });
  return { poller, recap, posts, edits, advance: (ms: number) => (t += ms) };
}

const rrUpdate = (matchId: string, earned: number): RrUpdate => ({ matchId, earned, after: 45, tierAfter: 13, tierBefore: 13 });

test("one recap per match for every roster member in it; RR now for one, pending for the other", async () => {
  const m = match("m-1");
  const pd = fakePd({ matches: [m], rr: { "p-owner": [rrUpdate("m-1", 21)] } });
  const x = setup(rosterWithOwnerAndMember(), pd);
  await x.poller.poll(x.recap.roster[OWNER]!, { sweep: false });
  expect(x.posts).toHaveLength(1);
  const d = x.posts[0]!.embeds[0]!.description!;
  expect(d).toContain("+21 RR");
  expect(d).toContain("RR …");
  expect(x.recap.postedMatches[0]).toMatchObject({ matchId: "m-1", messageId: "msg-1", rrPending: ["p-member"], tracked: ["p-owner", "p-member"], late: false });
  expect(x.recap.lastSeenMatch["p-owner"]).toBe("m-1");
});

test("the member's later poll doesn't post it again, and fills in their RR by editing", async () => {
  const m = match("m-1");
  const rr: Record<string, RrUpdate[]> = { "p-owner": [rrUpdate("m-1", 21)] };
  const x = setup(rosterWithOwnerAndMember(), fakePd({ matches: [m], rr }));
  await x.poller.poll(x.recap.roster[OWNER]!, { sweep: false });
  rr["p-member"] = [rrUpdate("m-1", -18)];
  await x.poller.poll(x.recap.roster[MEMBER]!, { sweep: false });
  expect(x.posts).toHaveLength(1);
  expect(x.edits).toHaveLength(1);
  expect(x.edits[0]!.id).toBe("msg-1");
  expect(x.edits[0]!.message.embeds[0]!.description).toContain("-18 RR");
  expect(x.recap.postedMatches[0]!.rrPending).toEqual([]);
});

test("RR that never arrives is dropped after 15 minutes", async () => {
  const x = setup(rosterWithOwnerAndMember(), fakePd({ matches: [match("m-1")] }));
  await x.poller.poll(x.recap.roster[OWNER]!, { sweep: false });
  x.advance(GIVE_UP_RR_MS);
  await x.poller.poll(x.recap.roster[OWNER]!, { sweep: false });
  expect(x.edits).toHaveLength(1);
  expect(x.edits[0]!.message.embeds[0]!.description).not.toContain("RR");
  expect(x.recap.postedMatches[0]!.rrPending).toEqual([]);
});

test("a match Riot hasn't finished is retried next poll, and given up on after 30 minutes", async () => {
  const unfinished = match("m-1", "competitive", false);
  const x = setup(rosterWithOwnerAndMember(), fakePd({ matches: [unfinished] }));
  await x.poller.poll(x.recap.roster[OWNER]!, { sweep: false });
  expect(x.posts).toHaveLength(0);
  expect(x.recap.lastSeenMatch["p-owner"]).toBeUndefined();
  x.advance(GIVE_UP_NOT_READY_MS);
  await x.poller.poll(x.recap.roster[OWNER]!, { sweep: false });
  expect(x.posts).toHaveLength(0);
  expect(x.recap.lastSeenMatch["p-owner"]).toBe("m-1");
});

test("other queues, and matches from before the person joined the roster, are skipped but marked seen", async () => {
  const dm = match("m-dm", "deathmatch");
  const old = match("m-old", "competitive", true, new Date(T0 - 120 * MIN).toISOString()); // the roster entries were added at T0 - 60 min
  const x = setup(rosterWithOwnerAndMember(), fakePd({ matches: [dm, old] }));
  await x.poller.poll(x.recap.roster[OWNER]!, { sweep: false });
  expect(x.posts).toHaveLength(0);
  expect(x.recap.lastSeenMatch["p-owner"]).toBe("m-dm");
});

test("someone switched off isn't in the recap; with nobody on, nothing is posted", async () => {
  const roster = rosterWithOwnerAndMember();
  roster[MEMBER]!.enabled = false;
  const x = setup(roster, fakePd({ matches: [match("m-1")] }));
  await x.poller.poll(roster[OWNER]!, { sweep: false });
  expect(x.recap.postedMatches[0]!.tracked).toEqual(["p-owner"]);
  roster[OWNER]!.enabled = false;
  const y = setup(roster, fakePd({ matches: [match("m-2")] }));
  await y.poller.poll(roster[OWNER]!, { sweep: false });
  expect(y.posts).toHaveLength(0);
});

test("a stale session (401 / BAD_CLAIMS) is dropped and the call retried once", async () => {
  const pd = fakePd({ matches: [match("m-1")] });
  pd.staleOnce();
  const x = setup(rosterWithOwnerAndMember(), pd);
  await x.poller.poll(x.recap.roster[OWNER]!, { sweep: false });
  expect(pd.calls.slice(0, 4)).toEqual(["session:p-owner", "history:p-owner", "drop:p-owner", "session:p-owner"]);
  expect(x.posts).toHaveLength(1);
});

test("a followed friend goes through HenrikDev, RR from their MMR history", async () => {
  const roster: Roster = {};
  join(roster, FRIEND, { kind: "none" }, { puuid: "p-friend", riotName: "Friend#3", region: "ap" }, new Date(T0 - 60 * MIN));
  const m = match("m-9");
  const henrik: Henrik = {
    account: async () => null,
    newestMatch: async () => m,
    rrHistory: async () => [rrUpdate("m-9", 15)],
  };
  const x = setup(roster, null, henrik);
  await x.poller.poll(roster[FRIEND]!, { sweep: false });
  expect(x.posts).toHaveLength(1);
  expect(x.posts[0]!.embeds[0]!.description).toContain("+15 RR");
  expect(x.recap.postedMatches[0]!.rrPending).toEqual([]);
});

test("the sweep marks finds late, doesn't repost, and doesn't move the last-seen marker", async () => {
  const x = setup(rosterWithOwnerAndMember(), fakePd({ matches: [match("m-1")] }));
  await x.poller.poll(x.recap.roster[OWNER]!, { sweep: true });
  expect(x.recap.postedMatches[0]!.late).toBe(true);
  expect(x.posts[0]!.embeds[0]!.footer?.text).toContain("late");
  expect(x.recap.lastSeenMatch["p-owner"]).toBeUndefined();
  await x.poller.poll(x.recap.roster[OWNER]!, { sweep: true });
  expect(x.posts).toHaveLength(1);
});

test("a failed post records nothing, so the next poll tries again", async () => {
  const roster = rosterWithOwnerAndMember();
  const recap: RecapState = { ...emptyRecapState(), roster };
  let fail = true;
  const posts: DiscordMessage[] = [];
  const poller = createRecapPoller({
    recap, save: async () => {}, queues: ["competitive"], names: () => null, pd: fakePd({ matches: [match("m-1")] }), henrik: null,
    post: async (m) => {
      if (fail) throw new Error("Discord 500");
      posts.push(m);
      return "msg-1";
    },
    edit: async () => {},
    now: () => T0,
  });
  await expect(poller.poll(roster[OWNER]!, { sweep: false })).rejects.toThrow("Discord 500");
  expect(recap.postedMatches).toEqual([]);
  expect(recap.lastSeenMatch["p-owner"]).toBeUndefined();
  fail = false;
  await poller.poll(roster[OWNER]!, { sweep: false });
  expect(posts).toHaveLength(1);
});
