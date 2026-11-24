import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountRegistry,
  addMember,
  displayName,
  ensureOwner,
  findByPuuid,
  MAX_MEMBERS,
  members,
  removeMember,
  setRiotIdentity,
} from "../src/accounts.ts";
import { loadState } from "../src/state.ts";

const OWNER = "100000000000000001";
const FRIEND = "200000000000000002";
const OTHER = "300000000000000003";
const T0 = new Date("2026-11-24T00:00:00Z");

const owner = (puuid: string | null = null, discordUsername = "owner") => ({ discordUserId: OWNER, discordUsername, puuid });

test("ensureOwner adds the owner once, with the owner role and the existing PUUID", () => {
  const reg: AccountRegistry = {};
  expect(ensureOwner(reg, owner("puuid-owner"), T0)).toBe(true);
  expect(reg[OWNER]).toEqual({
    discordUserId: OWNER,
    discordUsername: "owner",
    puuid: "puuid-owner",
    riotName: null,
    linkedAt: T0.toISOString(),
    role: "owner",
  });
  // A second start with nothing new changes nothing, so it needs no save.
  expect(ensureOwner(reg, owner("puuid-owner"), T0)).toBe(false);
});

test("ensureOwner picks up a new username and PUUID, and keeps the stored name when the lookup failed", () => {
  const reg: AccountRegistry = {};
  ensureOwner(reg, owner(null, "owner"), T0);
  expect(ensureOwner(reg, owner("puuid-owner", "renamed"), T0)).toBe(true);
  expect(reg[OWNER]?.discordUsername).toBe("renamed");
  expect(reg[OWNER]?.puuid).toBe("puuid-owner");
  expect(ensureOwner(reg, owner("puuid-owner", ""), T0)).toBe(false);
  expect(reg[OWNER]?.discordUsername).toBe("renamed");
});

test("a member links by Discord user id, and the Riot side is empty until their login succeeds", () => {
  const reg: AccountRegistry = {};
  const added = addMember(reg, { discordUserId: FRIEND, discordUsername: "friend" }, T0);
  expect(added.ok).toBe(true);
  expect(reg[FRIEND]).toMatchObject({ discordUserId: FRIEND, discordUsername: "friend", puuid: null, riotName: null, role: "member" });
  expect(displayName(reg[FRIEND]!)).toBe("friend");
});

test("setRiotIdentity ties the Discord user to a Riot account; both halves can be looked up", () => {
  const reg: AccountRegistry = {};
  addMember(reg, { discordUserId: FRIEND, discordUsername: "friend" }, T0);
  expect(setRiotIdentity(reg, FRIEND, { puuid: "puuid-friend", riotName: "Friend#0001" }).ok).toBe(true);
  expect(findByPuuid(reg, "puuid-friend")?.discordUserId).toBe(FRIEND);
  expect(displayName(reg[FRIEND]!)).toBe("friend (Friend#0001)");
});

test("one Riot account can't be linked to two Discord users", () => {
  const reg: AccountRegistry = {};
  addMember(reg, { discordUserId: FRIEND, discordUsername: "friend" }, T0);
  addMember(reg, { discordUserId: OTHER, discordUsername: "other" }, T0);
  setRiotIdentity(reg, FRIEND, { puuid: "puuid-shared", riotName: null });
  const second = setRiotIdentity(reg, OTHER, { puuid: "puuid-shared", riotName: null });
  expect(second.ok).toBe(false);
  expect(reg[OTHER]?.puuid).toBeNull();
  // Signing in again with the same account is fine.
  expect(setRiotIdentity(reg, FRIEND, { puuid: "puuid-shared", riotName: null }).ok).toBe(true);
});

test("linking twice is refused, for a member and for the owner", () => {
  const reg: AccountRegistry = {};
  ensureOwner(reg, owner(), T0);
  addMember(reg, { discordUserId: FRIEND, discordUsername: "friend" }, T0);
  expect(addMember(reg, { discordUserId: FRIEND, discordUsername: "friend" }, T0)).toEqual({ ok: false, reason: "You're already linked." });
  const again = addMember(reg, { discordUserId: OWNER, discordUsername: "owner" }, T0);
  expect(again.ok).toBe(false);
  expect(reg[OWNER]?.role).toBe("owner");
});

test("removing a member deletes their entry; the owner can't be removed", () => {
  const reg: AccountRegistry = {};
  ensureOwner(reg, owner(), T0);
  addMember(reg, { discordUserId: FRIEND, discordUsername: "friend" }, T0);
  expect(removeMember(reg, FRIEND).ok).toBe(true);
  expect(reg[FRIEND]).toBeUndefined();
  expect(removeMember(reg, FRIEND)).toEqual({ ok: false, reason: "You aren't linked." });
  expect(removeMember(reg, OWNER).ok).toBe(false);
  expect(reg[OWNER]).toBeDefined();
});

test("members are capped, and the owner doesn't count", () => {
  const reg: AccountRegistry = {};
  ensureOwner(reg, owner(), T0);
  for (let i = 0; i < MAX_MEMBERS; i++) {
    expect(addMember(reg, { discordUserId: `4000000000000000${10 + i}`, discordUsername: `m${i}` }, new Date(T0.getTime() + i)).ok).toBe(true);
  }
  expect(addMember(reg, { discordUserId: FRIEND, discordUsername: "friend" }, T0).ok).toBe(false);
  expect(members(reg)).toHaveLength(MAX_MEMBERS);
  expect(members(reg)[0]?.discordUsername).toBe("m0"); // oldest link first
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daily-drip-accounts-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a state file from before the registry loads with no accounts and keeps its other fields", async () => {
  const path = join(dir, "state.json");
  await writeFile(path, JSON.stringify({ version: 1, puuid: "puuid-owner", shard: "ap", wishlist: ["Reaver"] }));
  const state = await loadState(path);
  expect(state.accounts).toEqual({});
  expect(state.puuid).toBe("puuid-owner");
  expect(state.wishlist).toEqual(["Reaver"]);
});
