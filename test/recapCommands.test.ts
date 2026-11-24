import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import type { Henrik } from "../src/henrik.ts";
import { createRecapCommands, JOIN_EXPLAINER, JOIN_NO, JOIN_YES, type RecapCommandDeps } from "../src/recapCommands.ts";
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
      options: { getSubcommand: () => sub, getString: (n: string) => strings[n] ?? null, getUser: () => user ?? null },
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
