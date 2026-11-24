import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import type { Henrik } from "../src/henrik.ts";
import { createRecapCommands, JOIN_EXPLAINER, JOIN_NO, JOIN_YES, type RecapCommandDeps } from "../src/recapCommands.ts";
import type { MatchRecap } from "../src/recap.ts";
import type { Person } from "../src/recapLookup.ts";
import type { PdApi } from "../src/recapPoll.ts";
import type { Roster, Standing } from "../src/roster.ts";

const OWNER = "100000000000000001";
const MEMBER = "200000000000000002";
const FRIEND = "300000000000000003";

function setup(over: Partial<RecapCommandDeps> = {}) {
  const roster: Roster = {};
  const announced: string[] = [];
  let saves = 0;
  let t = 0;
  const standings: Record<string, Standing> = { [OWNER]: { kind: "owner", puuid: "p-owner" }, [MEMBER]: { kind: "member", puuid: "p-member" } };
  const henrik: Henrik = {
    account: async (id) => (id === "Friend#0003" ? { puuid: "p-friend", name: "Friend", tag: "0003", region: "ap" } : null),
    newestMatch: async () => null,
    matches: async () => [],
    rrHistory: async () => [],
  };
  const deps: RecapCommandDeps = {
    ownerId: OWNER,
    roster: () => roster,
    save: async () => void saves++,
    standing: (id) => standings[id] ?? { kind: "none" },
    riotNameOf: () => null,
    henrik,
    announce: async (text) => void announced.push(text),
    people: () => [],
    lookup: { pd: null, henrik },
    names: () => null,
    now: () => t,
    ...over,
  };
  return { cmds: createRecapCommands(deps), roster, announced, saves: () => saves, advance: (ms: number) => (t += ms) };
}

function cmd(userId: string, sub: string, strings: Record<string, string> = {}, user?: { id: string; username: string }) {
  const events: Array<{ kind: string; options: any }> = [];
  const rec = (kind: string) => async (options?: any) => void events.push({ kind, options });
  return {
    events,
    i: {
      user: { id: userId, username: `u${userId.slice(0, 2)}` },
      options: { getSubcommand: () => sub, getString: (n: string) => strings[n] ?? null, getUser: () => user ?? null, getInteger: (n: string) => (strings[n] ? Number(strings[n]) : null) },
      reply: rec("reply"),
      deferReply: rec("defer"),
      editReply: rec("edit"),
    },
  };
}

function btn(userId: string, customId: string) {
  const events: Array<{ kind: string; options: any }> = [];
  return { events, b: { user: { id: userId, username: "f" }, customId, update: async (o: any) => void events.push({ kind: "update", options: o }), reply: async (o: any) => void events.push({ kind: "reply", options: o }) } };
}

test("/recap on for a linked member adds them; off keeps the entry; replies are private", async () => {
  const x = setup();
  const on = cmd(MEMBER, "on");
  await x.cmds.command(on.i);
  expect(x.roster[MEMBER]).toMatchObject({ tier: "linked", enabled: true });
  expect(on.events[0]?.options.flags).toBe(MessageFlags.Ephemeral);
  await x.cmds.command(cmd(MEMBER, "off").i);
  expect(x.roster[MEMBER]?.enabled).toBe(false);
});

test("/recap join: explains first with a Confirm button; only Confirm adds them, and it's announced", async () => {
  const x = setup();
  const join = cmd(FRIEND, "join", { riot_id: "Friend#0003" });
  await x.cmds.command(join.i);
  expect(join.events.map((e) => e.kind)).toEqual(["defer", "edit"]);
  expect(join.events[1]?.options.content).toBe(JOIN_EXPLAINER);
  expect(x.roster[FRIEND]).toBeUndefined();
  const yes = btn(FRIEND, JOIN_YES);
  await x.cmds.button(yes.b);
  expect(x.roster[FRIEND]).toMatchObject({ tier: "followed", puuid: "p-friend", riotName: "Friend#0003", region: "ap" });
  expect(x.announced).toEqual([`<@${FRIEND}> joined match recaps as **Friend#0003**.`]);
});

test("/recap join: Cancel saves nothing; an unknown ID, a linked person, or an expired request don't join", async () => {
  const x = setup();
  await x.cmds.command(cmd(FRIEND, "join", { riot_id: "Friend#0003" }).i);
  await x.cmds.button(btn(FRIEND, JOIN_NO).b);
  expect(x.roster[FRIEND]).toBeUndefined();

  const unknown = cmd(FRIEND, "join", { riot_id: "Nobody#0000" });
  await x.cmds.command(unknown.i);
  expect(unknown.events[1]?.options.content).toContain("No Riot account");

  const linked = cmd(MEMBER, "join", { riot_id: "Friend#0003" });
  await x.cmds.command(linked.i);
  expect(linked.events[0]?.options.content).toContain("/recap on");

  await x.cmds.command(cmd(FRIEND, "join", { riot_id: "Friend#0003" }).i);
  x.advance(6 * 60_000);
  const late = btn(FRIEND, JOIN_YES);
  await x.cmds.button(late.b);
  expect(late.events[0]?.options.content).toContain("expired");
  expect(x.roster[FRIEND]).toBeUndefined();
});

test("someone else pressing Confirm doesn't join anyone", async () => {
  const x = setup();
  await x.cmds.command(cmd(FRIEND, "join", { riot_id: "Friend#0003" }).i);
  await x.cmds.button(btn("999999999999999999", JOIN_YES).b);
  expect(Object.keys(x.roster)).toEqual([]);
});

test("/recap join is off without a HenrikDev key", async () => {
  const x = setup({ henrik: null });
  const join = cmd(FRIEND, "join", { riot_id: "Friend#0003" });
  await x.cmds.command(join.i);
  expect(join.events[0]?.options.content).toContain("isn't set up");
});

test("/recap remove is owner-only; it deletes a followed entry or switches a linked one off", async () => {
  const x = setup();
  await x.cmds.command(cmd(MEMBER, "on").i);
  await x.cmds.command(cmd(FRIEND, "join", { riot_id: "Friend#0003" }).i);
  await x.cmds.button(btn(FRIEND, JOIN_YES).b);

  const notOwner = cmd(MEMBER, "remove", {}, { id: FRIEND, username: "f" });
  await x.cmds.command(notOwner.i);
  expect(notOwner.events[0]?.options.content).toContain("Only the bot's owner");
  expect(x.roster[FRIEND]).toBeDefined();

  await x.cmds.command(cmd(OWNER, "remove", {}, { id: FRIEND, username: "f" }).i);
  expect(x.roster[FRIEND]).toBeUndefined();
  await x.cmds.command(cmd(OWNER, "remove", {}, { id: MEMBER, username: "m" }).i);
  expect(x.roster[MEMBER]?.enabled).toBe(false);
});

test("/recap list is public and pings nobody; leave and trigger work for a followed member", async () => {
  const x = setup();
  await x.cmds.command(cmd(FRIEND, "join", { riot_id: "Friend#0003" }).i);
  await x.cmds.button(btn(FRIEND, JOIN_YES).b);
  await x.cmds.command(cmd(FRIEND, "trigger", { mode: "poll" }).i);
  const list = cmd(OWNER, "list");
  await x.cmds.command(list.i);
  expect(list.events[0]?.options.flags).toBeUndefined();
  expect(list.events[0]?.options.allowedMentions).toEqual({ parse: [] });
  expect(list.events[0]?.options.content).toContain(`<@${FRIEND}> Friend#0003 · followed · polled`);
  await x.cmds.command(cmd(FRIEND, "leave").i);
  expect(x.roster[FRIEND]).toBeUndefined();
});

// ---------- /recap show ----------


const showMatch = (id: string, players: string[], queue = "competitive"): MatchRecap => ({
  matchId: id, mapId: "/Game/Maps/Ascent/Ascent", queue, startedAt: "2026-11-24T15:00:00.000Z", lengthMinutes: 35, completed: true, rounds: 22,
  teams: [{ teamId: "Blue", won: true, roundsWon: 13 }, { teamId: "Red", won: false, roundsWon: 9 }],
  players: players.map((puuid) => ({ puuid, riotName: `${puuid}#1`, teamId: "Blue", partyId: null, agentId: "x", tier: 13, kills: 10, deaths: 5, assists: 2, acs: 200, hsPercent: 20, adr: 140 })),
});

const ownerPerson: Person = { discordUserId: OWNER, discordUsername: "tyler", riotName: "Tyler#0001", puuid: "p-owner", linked: true, region: null };
const followedPerson: Person = { discordUserId: FRIEND, discordUsername: "friendo", riotName: "Friend#0003", puuid: "p-friend", linked: false, region: "ap" };

function pdWith(history: MatchRecap[]): PdApi & { sessions: string[] } {
  const sessions: string[] = [];
  return {
    sessions,
    async session(e) {
      sessions.push(e.discordUserId);
      return { accessToken: "AT", idToken: "", entitlementsToken: "", puuid: e.puuid, shard: "ap", riotName: null };
    },
    dropSession() {},
    async history(_s, count) {
      return history.slice(0, count).map((m) => ({ matchId: m.matchId, startedAt: m.startedAt, queue: m.queue }));
    },
    async details(_s, id) {
      return history.find((m) => m.matchId === id)!;
    },
    async rr() {
      return [{ matchId: "m-2", earned: 18, after: 30, tierAfter: 13, tierBefore: 13 }];
    },
  };
}

test("/recap show with no player: the caller's latest match, from their own session, pinging nobody", async () => {
  const pd = pdWith([showMatch("m-1", ["p-owner"]), showMatch("m-2", ["p-owner"])]);
  const x = setup({ people: () => [ownerPerson], lookup: { pd, henrik: null } });
  const c = cmd(OWNER, "show");
  await x.cmds.command(c.i);
  expect(c.events.map((e) => e.kind)).toEqual(["defer", "edit"]);
  expect(c.events[0]?.options).toBeUndefined(); // public
  const reply = c.events[1]?.options;
  expect(reply.content).toBe("**Recap** · Tyler#0001's latest match");
  expect(reply.allowedMentions).toEqual({ parse: [] });
  expect(reply.embeds[0].footer.text).toContain("m-1");
  expect(pd.sessions).toEqual([OWNER]);
});

test("/recap show match:2 picks the one before, with RR from the person's own session", async () => {
  const pd = pdWith([showMatch("m-1", ["p-owner"]), showMatch("m-2", ["p-owner"])]);
  const x = setup({ people: () => [ownerPerson], lookup: { pd, henrik: null } });
  const c = cmd(OWNER, "show", { match: "2", player: `user:${OWNER}` });
  await x.cmds.command(c.i);
  expect(c.events[1]?.options.content).toBe("**Recap** · Tyler#0001's match 2 back");
  expect(c.events[1]?.options.embeds[0].description).toContain("+18 RR");
});

test("/recap show for a followed friend or any Riot ID goes through HenrikDev", async () => {
  const henrikMatches: Record<string, MatchRecap[]> = { "p-friend": [showMatch("h-1", ["p-friend"], "unrated")], "p-stranger": [showMatch("h-9", ["p-stranger"], "unrated")] };
  const henrik = {
    account: async (id: string) => (id === "Stranger#9999" ? { puuid: "p-stranger", name: "Stranger", tag: "9999", region: "eu" } : null),
    newestMatch: async () => null,
    matches: async (_r: string, puuid: string) => henrikMatches[puuid] ?? [],
    rrHistory: async () => [],
  };
  const x = setup({ henrik, people: () => [ownerPerson, followedPerson], lookup: { pd: null, henrik } });
  const friend = cmd(OWNER, "show", { player: "friendo" });
  await x.cmds.command(friend.i);
  expect(friend.events[1]?.options.content).toBe("**Recap** · Friend#0003's latest match");
  const stranger = cmd(OWNER, "show", { player: "Stranger#9999" });
  await x.cmds.command(stranger.i);
  expect(stranger.events[1]?.options.content).toBe("**Recap** · Stranger#9999's latest match");
  const unknown = cmd(OWNER, "show", { player: "Nobody#0000" });
  await x.cmds.command(unknown.i);
  expect(unknown.events[1]?.options.content).toContain("No Riot account");
});

test("/recap show: a match number beyond the history, and someone the bot doesn't know, say so", async () => {
  const pd = pdWith([showMatch("m-1", ["p-owner"])]);
  const x = setup({ people: () => [ownerPerson], lookup: { pd, henrik: null } });
  const far = cmd(OWNER, "show", { match: "3" });
  await x.cmds.command(far.i);
  expect(far.events[1]?.options.content).toContain("no match number 3");
  const stranger = cmd(FRIEND, "show");
  await x.cmds.command(stranger.i);
  expect(stranger.events[1]?.options.content).toContain("aren't linked or followed");
});
