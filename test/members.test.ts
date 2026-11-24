import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AccountRegistry, addMember, ensureOwner, MAX_MEMBERS } from "../src/accounts.ts";
import { TIERS_URL, VERSION_URL, WEAPONS_URL } from "../src/catalog.ts";
import { canStartLink, completeLink, fetchMemberShop, type MemberDeps, PASTE_HELP } from "../src/members.ts";
import { PAS_URL, USERINFO_URL } from "../src/riot/auth.ts";
import { LoginDeadError, TOKEN_URL } from "../src/riot/login.ts";
import { importKey, open } from "../src/secretbox.ts";
import { fakeRiot, linkRoutes, LEVEL_JUDGE, LEVEL_VANDAL, PUUID, type Route, STOREFRONT_URL, storefrontBody, tiersData, versionRoute, weaponsData } from "./fakes.ts";

const OWNER = "100000000000000001";
const FRIEND = "200000000000000002";
const PASTE = "http://localhost/redirect?iss=x&code=ONE-TIME-CODE-123";
const KEY = await importKey(Buffer.alloc(32, 7).toString("base64"));

let dir: string;
let saves: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daily-drip-members-"));
  saves = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** /token answers per grant: the code gives rt-1; a refresh gives `rotateTo` (or omits it). */
function tokenRoute(opts: { rotateTo?: string; codeError?: string; refreshError?: string } = {}): Route {
  return (options) => {
    const form = new URLSearchParams(options.body ?? "");
    if (form.get("grant_type") === "authorization_code") {
      if (opts.codeError) return Response.json({ error: opts.codeError }, { status: 400 });
      return Response.json({ access_token: "AT", id_token: "IT", refresh_token: "rt-1", expires_in: 3600 });
    }
    if (opts.refreshError) return Response.json({ error: opts.refreshError }, { status: 400 });
    return Response.json({ access_token: "AT", id_token: "IT", ...(opts.rotateTo ? { refresh_token: opts.rotateTo } : {}) });
  };
}

function riot(overrides: Record<string, Route> = {}) {
  return fakeRiot({
    [TOKEN_URL]: tokenRoute(),
    [USERINFO_URL]: () => Response.json({ sub: PUUID, acct: { game_name: "Friend", tag_line: "0001" } }),
    [VERSION_URL]: versionRoute(),
    [STOREFRONT_URL]: () => Response.json(storefrontBody([LEVEL_VANDAL, LEVEL_JUDGE], { [LEVEL_VANDAL]: 2175, [LEVEL_JUDGE]: 1775 })),
    [WEAPONS_URL]: () => Response.json({ status: 200, data: weaponsData }),
    [TIERS_URL]: () => Response.json({ status: 200, data: tiersData }),
    ...linkRoutes(),
    ...overrides,
  });
}

function deps(http: MemberDeps["http"]): MemberDeps {
  return { http, key: KEY, save: async () => void saves++, catalogFile: join(dir, "catalog.json"), now: () => new Date("2026-11-24T00:00:00Z") };
}

function withOwner(ownerPuuid: string | null = "puuid-owner"): AccountRegistry {
  const reg: AccountRegistry = {};
  ensureOwner(reg, { discordUserId: OWNER, discordUsername: "owner", puuid: ownerPuuid });
  return reg;
}

const friend = { discordUserId: FRIEND, discordUsername: "friend" };

test("canStartLink: the owner can't, members can until the cap, and a linked member can link again", () => {
  const reg = withOwner();
  expect(canStartLink(reg, OWNER).ok).toBe(false);
  expect(canStartLink(reg, FRIEND).ok).toBe(true);
  for (let i = 0; i < MAX_MEMBERS; i++) addMember(reg, { discordUserId: `40000000000000${100 + i}`, discordUsername: `m${i}` });
  expect(canStartLink(reg, FRIEND).ok).toBe(false);
  expect(canStartLink(reg, "40000000000000100").ok).toBe(true);
});

test("completeLink links a new member: Riot ID, PUUID and shard filled in, refresh token sealed", async () => {
  const reg = withOwner();
  const result = await completeLink(reg, friend, PASTE, deps(riot().http));
  expect(result.ok).toBe(true);
  const account = reg[FRIEND]!;
  expect(account).toMatchObject({ role: "member", puuid: PUUID, riotName: "Friend#0001", discordUsername: "friend" });
  expect(account.member?.shard).toBe("ap");
  expect(account.member?.sealedRefreshToken).not.toContain("rt-1");
  expect(await open(KEY, account.member!.sealedRefreshToken)).toBe("rt-1");
  expect(saves).toBeGreaterThan(0);
});

test("a bad paste is refused before anything is sent to Riot", async () => {
  const reg = withOwner();
  const fake = riot();
  const result = await completeLink(reg, friend, "https://example.com/?code=nope", deps(fake.http));
  expect(result).toEqual({ ok: false, reason: `That doesn't look like the right address. ${PASTE_HELP}` });
  expect(fake.calls).toHaveLength(0);
  expect(reg[FRIEND]).toBeUndefined();
});

test("signing in with a Riot account that's already linked (here the owner's) is refused and changes nothing", async () => {
  const reg = withOwner(PUUID);
  const result = await completeLink(reg, friend, PASTE, deps(riot().http));
  expect(result.ok).toBe(false);
  expect(reg[FRIEND]).toBeUndefined();
});

test("a used or expired code asks for a new /link", async () => {
  const reg = withOwner();
  const result = await completeLink(reg, friend, PASTE, deps(riot({ [TOKEN_URL]: tokenRoute({ codeError: "invalid_grant" }) }).http));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("already used or has expired");
  expect(reg[FRIEND]).toBeUndefined();
});

test("linking again with the same account keeps the shop and wishlist; another account keeps only the wishlist", async () => {
  const reg = withOwner();
  await completeLink(reg, friend, PASTE, deps(riot().http));
  const member = reg[FRIEND]!.member!;
  member.wishlist = ["Reaver"];
  member.lastSentHash = "h1";

  await completeLink(reg, friend, PASTE, deps(riot().http));
  expect(reg[FRIEND]!.member).toMatchObject({ wishlist: ["Reaver"], lastSentHash: "h1" });

  const other = riot({ [USERINFO_URL]: () => Response.json({ sub: "puuid-other", acct: { game_name: "Alt", tag_line: "0002" } }) });
  await completeLink(reg, friend, PASTE, deps(other.http));
  expect(reg[FRIEND]).toMatchObject({ puuid: "puuid-other", riotName: "Alt#0002" });
  expect(reg[FRIEND]!.member).toMatchObject({ wishlist: ["Reaver"], lastSentHash: null, snapshot: null });
});

test("a member's run reaches their shop, and a rotated refresh token is sealed and saved", async () => {
  const reg = withOwner();
  await completeLink(reg, friend, PASTE, deps(riot().http));
  const account = reg[FRIEND]!;
  const fake = riot({ [TOKEN_URL]: tokenRoute({ rotateTo: "rt-2" }) });

  const snapshot = await fetchMemberShop(account, deps(fake.http));
  expect(snapshot.offers.map((o) => o.name)).toEqual(["Imperium Vandal", "Celestial Judge"]);
  expect(account.member?.snapshot).toEqual(snapshot);
  expect(await open(KEY, account.member!.sealedRefreshToken)).toBe("rt-2");
  // The shard was cached at link time, so E4 doesn't run again; E3 does, for the current Riot ID.
  expect(fake.urls()).not.toContain(PAS_URL);
  expect(fake.urls()).toContain(USERINFO_URL);
});

test("a refresh that doesn't rotate leaves the sealed token alone", async () => {
  const reg = withOwner();
  await completeLink(reg, friend, PASTE, deps(riot().http));
  const before = reg[FRIEND]!.member!.sealedRefreshToken;
  await fetchMemberShop(reg[FRIEND]!, deps(riot().http));
  expect(reg[FRIEND]!.member!.sealedRefreshToken).toBe(before);
});

test("a dead sign-in throws LoginDeadError, so the scheduler can ask the member to link again", async () => {
  const reg = withOwner();
  await completeLink(reg, friend, PASTE, deps(riot().http));
  const dead = riot({ [TOKEN_URL]: tokenRoute({ refreshError: "invalid_grant" }) });
  await expect(fetchMemberShop(reg[FRIEND]!, deps(dead.http))).rejects.toBeInstanceOf(LoginDeadError);
});

test("a member who changed their Riot ID gets the new one on their next run", async () => {
  const reg = withOwner();
  await completeLink(reg, friend, PASTE, deps(riot().http));
  const renamed = riot({ [USERINFO_URL]: () => Response.json({ sub: PUUID, acct: { game_name: "NewName", tag_line: "0001" } }) });
  await fetchMemberShop(reg[FRIEND]!, deps(renamed.http));
  expect(reg[FRIEND]?.riotName).toBe("NewName#0001");
});
