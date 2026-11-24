import { expect, test } from "bun:test";
import { type AccountRegistry, addMember, ensureOwner, type LinkedAccount } from "../src/accounts.ts";
import { createMemberScheduler } from "../src/memberScheduler.ts";
import { RateLimitedError } from "../src/riot/auth.ts";
import { LoginDeadError } from "../src/riot/login.ts";
import { AFTER_RESET_MS, DEFAULT_RETRY_MS } from "../src/scheduler.ts";
import type { ShopSnapshot } from "../src/shop.ts";

const T0 = Date.parse("2026-11-24T00:05:00Z");
const RESET = "2026-11-25T00:00:00.000Z";
const shop = (expiresAt = RESET): ShopSnapshot => ({ fetchedAt: "", expiresAt, hash: "h", offers: [] });

function registry(n: number, linked = true): AccountRegistry {
  const reg: AccountRegistry = {};
  ensureOwner(reg, { discordUserId: "100000000000000001", discordUsername: "owner", puuid: "p-owner" });
  for (let i = 0; i < n; i++) {
    const added = addMember(reg, { discordUserId: `20000000000000000${i}`, discordUsername: `m${i}` }, new Date(T0 + i));
    if (added.ok && linked) {
      added.value.member = { sealedRefreshToken: "x.y", shard: "ap", snapshot: null, wishlist: [], lastSentHash: null, lastSuccessAt: null, linkDeadNotified: false };
    }
  }
  return reg;
}

function setup(reg: AccountRegistry, run: (a: LinkedAccount) => Promise<ShopSnapshot>) {
  let now = T0;
  const sleeps: number[] = [];
  const ran: string[] = [];
  const notified: string[] = [];
  let saves = 0;
  const scheduler = createMemberScheduler({
    accounts: () => reg,
    run: async (a) => {
      ran.push(a.discordUsername);
      return run(a);
    },
    notifyLinkDead: async (a) => void notified.push(a.discordUsername),
    save: async () => void saves++,
    now: () => now,
    sleep: async (ms) => void sleeps.push(ms),
    gapMs: 5_000,
  });
  return { scheduler, ran, notified, sleeps, saves: () => saves, setNow: (t: number) => (now = t) };
}

test("members with no shop yet run at once, one after another with a gap, the owner never", async () => {
  const s = setup(registry(3), async () => shop());
  await s.scheduler.tick();
  expect(s.ran).toEqual(["m0", "m1", "m2"]);
  expect(s.sleeps).toEqual([5_000, 5_000]);
});

test("a successful run waits for the next reset + 90 s", async () => {
  const s = setup(registry(1), async () => shop());
  await s.scheduler.tick();
  expect(s.scheduler.nextRunAt("200000000000000000")).toBe(Date.parse(RESET) + AFTER_RESET_MS);
  await s.scheduler.tick();
  expect(s.ran).toEqual(["m0"]);
  s.setNow(Date.parse(RESET) + AFTER_RESET_MS);
  await s.scheduler.tick();
  expect(s.ran).toEqual(["m0", "m0"]);
});

test("members still mid-link (no sign-in yet) are skipped", async () => {
  const s = setup(registry(2, false), async () => shop());
  await s.scheduler.tick();
  expect(s.ran).toEqual([]);
});

test("a dead sign-in tells the member once, then stops running them", async () => {
  const reg = registry(1);
  const s = setup(reg, async () => {
    throw new LoginDeadError("invalid_grant");
  });
  await s.scheduler.tick();
  expect(s.notified).toEqual(["m0"]);
  expect(reg["200000000000000000"]?.member?.linkDeadNotified).toBe(true);
  expect(s.saves()).toBe(1);
  s.setNow(T0 + 48 * 3600_000);
  await s.scheduler.tick();
  expect(s.ran).toEqual(["m0"]);
  expect(s.notified).toEqual(["m0"]);
});

test("a rate limit stops the round for everyone and retries that member after Retry-After", async () => {
  const s = setup(registry(3), async (a) => {
    if (a.discordUsername === "m1") throw new RateLimitedError("auth.riotgames.com", 600);
    return shop();
  });
  await s.scheduler.tick();
  expect(s.ran).toEqual(["m0", "m1"]);
  expect(s.scheduler.nextRunAt("200000000000000001")).toBe(T0 + 600_000);
});

test("other failures retry that member later and carry on with the rest", async () => {
  const s = setup(registry(2), async (a) => {
    if (a.discordUsername === "m0") throw new Error("E6 storefront returned 500");
    return shop();
  });
  await s.scheduler.tick();
  expect(s.ran).toEqual(["m0", "m1"]);
  expect(s.scheduler.nextRunAt("200000000000000000")).toBe(T0 + DEFAULT_RETRY_MS);
});

test("a member who doesn't accept DMs waits for the next reset instead of retrying all day", async () => {
  const reg = registry(1);
  const s = setup(reg, async (a) => {
    a.member!.snapshot = shop();
    throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
  });
  await s.scheduler.tick();
  expect(s.scheduler.nextRunAt("200000000000000000")).toBe(Date.parse(RESET) + AFTER_RESET_MS);
});

test("a member who unlinked is forgotten", async () => {
  const reg = registry(1);
  const s = setup(reg, async () => shop());
  await s.scheduler.tick();
  delete reg["200000000000000000"];
  await s.scheduler.tick();
  expect(s.scheduler.nextRunAt("200000000000000000")).toBeUndefined();
});
