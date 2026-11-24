import { expect, test } from "bun:test";
import {
  active,
  ensureOwnerEntry,
  join,
  leave,
  MAX_FOLLOWED,
  onUnlink,
  refreshRiotName,
  remove,
  type Roster,
  setTrigger,
  type Standing,
  turnOff,
  turnOn,
} from "../src/roster.ts";

const OWNER = "100000000000000001";
const MEMBER = "200000000000000002";
const FRIEND = "300000000000000003";
const T0 = new Date("2026-11-25T00:00:00Z");
const member: Standing = { kind: "member", puuid: "p-member" };
const none: Standing = { kind: "none" };
const friendAccount = { puuid: "p-friend", riotName: "Friend#0003", region: "ap" };

test("the owner is on the roster by default, once; turning it off sticks across restarts", () => {
  const roster: Roster = {};
  expect(ensureOwnerEntry(roster, { discordUserId: OWNER, puuid: "p-owner", riotName: "Owner#0001" }, T0)).toBe(true);
  expect(roster[OWNER]).toEqual({ discordUserId: OWNER, tier: "linked", enabled: true, trigger: "presence", puuid: "p-owner", riotName: "Owner#0001", region: null, addedAt: T0.toISOString() });
  turnOff(roster, OWNER);
  expect(ensureOwnerEntry(roster, { discordUserId: OWNER, puuid: "p-owner", riotName: null }, T0)).toBe(false);
  expect(roster[OWNER]?.enabled).toBe(false);
  // No PUUID yet (owner's first run hasn't happened): nothing to add.
  expect(ensureOwnerEntry({}, { discordUserId: OWNER, puuid: null, riotName: null })).toBe(false);
});

test("linking for the shop doesn't add a member; /recap on does, and off keeps the entry", () => {
  const roster: Roster = {};
  expect(roster[MEMBER]).toBeUndefined();
  expect(turnOn(roster, MEMBER, member, "Member#0002", T0).ok).toBe(true);
  expect(roster[MEMBER]).toMatchObject({ tier: "linked", enabled: true, puuid: "p-member" });
  turnOff(roster, MEMBER);
  expect(roster[MEMBER]?.enabled).toBe(false);
  expect(turnOn(roster, MEMBER, member, null).ok).toBe(true);
  expect(roster[MEMBER]?.enabled).toBe(true);
});

test("/recap on needs a link (or a finished one); a stranger is pointed to /link or /recap join", () => {
  expect(turnOn({}, FRIEND, none, null)).toEqual({ ok: false, reason: expect.stringContaining("/recap join") });
  expect(turnOn({}, MEMBER, { kind: "member", puuid: null }, null).ok).toBe(false);
});

test("/recap join: a non-linked member follows their own Riot ID; linked people are sent to /recap on", () => {
  const roster: Roster = {};
  expect(join(roster, FRIEND, none, friendAccount, T0).ok).toBe(true);
  expect(roster[FRIEND]).toEqual({ discordUserId: FRIEND, tier: "followed", enabled: true, trigger: "presence", puuid: "p-friend", riotName: "Friend#0003", region: "ap", addedAt: T0.toISOString() });
  expect(join(roster, MEMBER, member, { ...friendAccount, puuid: "p-x" }).ok).toBe(false);
  expect(join(roster, FRIEND, none, friendAccount).ok).toBe(false); // already on it
});

test("one entry per Riot account: a Riot ID already on the roster under someone else is refused", () => {
  const roster: Roster = {};
  join(roster, FRIEND, none, friendAccount);
  expect(join(roster, "400000000000000004", none, friendAccount)).toEqual({ ok: false, reason: expect.stringContaining("already on the recap roster") });
  expect(turnOn(roster, MEMBER, { kind: "member", puuid: "p-friend" }, null).ok).toBe(false);
});

test(`at most ${MAX_FOLLOWED} followed entries; linked ones don't count`, () => {
  const roster: Roster = {};
  ensureOwnerEntry(roster, { discordUserId: OWNER, puuid: "p-owner", riotName: null });
  for (let i = 0; i < MAX_FOLLOWED; i++) expect(join(roster, `5000000000000000${10 + i}`, none, { puuid: `p-${i}`, riotName: `F#${i}`, region: "ap" }).ok).toBe(true);
  expect(join(roster, FRIEND, none, friendAccount)).toEqual({ ok: false, reason: expect.stringContaining("limit") });
});

test("/recap leave deletes a followed entry; a linked one is told to use off or /unlink", () => {
  const roster: Roster = {};
  join(roster, FRIEND, none, friendAccount);
  turnOn(roster, MEMBER, member, null);
  expect(leave(roster, FRIEND).ok).toBe(true);
  expect(roster[FRIEND]).toBeUndefined();
  expect(leave(roster, MEMBER)).toEqual({ ok: false, reason: expect.stringContaining("/recap off") });
  expect(leave(roster, FRIEND).ok).toBe(false);
});

test("/recap remove (owner): deletes a followed entry, only switches a linked one off", () => {
  const roster: Roster = {};
  join(roster, FRIEND, none, friendAccount);
  turnOn(roster, MEMBER, member, null);
  expect(remove(roster, FRIEND)).toMatchObject({ ok: true, value: { deleted: true } });
  expect(roster[FRIEND]).toBeUndefined();
  expect(remove(roster, MEMBER)).toMatchObject({ ok: true, value: { deleted: false } });
  expect(roster[MEMBER]?.enabled).toBe(false);
});

test("unlinking removes a linked entry, never a followed one", () => {
  const roster: Roster = {};
  turnOn(roster, MEMBER, member, null);
  join(roster, FRIEND, none, friendAccount);
  expect(onUnlink(roster, MEMBER)).toBe(true);
  expect(roster[MEMBER]).toBeUndefined();
  expect(onUnlink(roster, FRIEND)).toBe(false);
  expect(roster[FRIEND]).toBeDefined();
});

test("active lists only enabled entries; the trigger can be switched to polling", () => {
  const roster: Roster = {};
  turnOn(roster, MEMBER, member, null);
  join(roster, FRIEND, none, friendAccount);
  turnOff(roster, MEMBER);
  expect(active(roster).map((e) => e.discordUserId)).toEqual([FRIEND]);
  expect(setTrigger(roster, FRIEND, "poll").ok).toBe(true);
  expect(roster[FRIEND]?.trigger).toBe("poll");
});

test("a rename seen in a match updates the shown Riot ID", () => {
  const roster: Roster = {};
  join(roster, FRIEND, none, friendAccount);
  expect(refreshRiotName(roster, "p-friend", "NewName#0003")).toBe(true);
  expect(roster[FRIEND]?.riotName).toBe("NewName#0003");
  expect(refreshRiotName(roster, "p-friend", "NewName#0003")).toBe(false);
  expect(refreshRiotName(roster, "p-unknown", "X#1")).toBe(false);
});
