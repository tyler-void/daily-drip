import { expect, test } from "bun:test";
import { createLock } from "../src/lock.ts";
import type { Notifier } from "../src/notify/notifier.ts";
import { postShop, SEND_RETRY_DELAYS_MS, withRetries } from "../src/post.ts";
import type { ShopOffer, ShopSnapshot } from "../src/shop.ts";
import { emptyState } from "../src/state.ts";

const offer = (name: string): ShopOffer => ({ levelUuid: name, name, iconUrl: null, vp: 1775, tier: null });
const snapshot = (hash = "today"): ShopSnapshot => ({
  fetchedAt: "",
  expiresAt: "2026-11-24T00:00:00.000Z",
  offers: [offer("Reaver Vandal"), offer("Prime Classic")],
  hash,
});

function setup(sendFailures = 0) {
  const state = emptyState();
  const sent: Array<{ snapshot: ShopSnapshot; hits: ShopOffer[] }> = [];
  const sleeps: number[] = [];
  let saves = 0;
  let failures = sendFailures;
  const notifier: Notifier = {
    sendShop: async (snap, hits) => {
      if (failures > 0) {
        failures--;
        throw new Error("Discord 503");
      }
      sent.push({ snapshot: snap, hits });
    },
    sendAlert: async () => {},
  };
  const deps = {
    state,
    save: async () => {
      saves++;
    },
    withLock: createLock(),
    fetchShop: async () => snapshot(),
    notifier,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return { deps, state, sent, sleeps, saves: () => saves };
}

test("posts a new shop with the wishlist hits, then records it as sent", async () => {
  const s = setup();
  s.state.wishlist = ["reaver"];
  await postShop(s.deps);
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0]?.hits.map((h) => h.name)).toEqual(["Reaver Vandal"]);
  expect(s.state.lastSentHash).toBe("today");
  expect(s.saves()).toBe(1);
});

test("a shop that was already sent is not posted again (restart on the same day)", async () => {
  const s = setup();
  s.state.lastSentHash = "today";
  await postShop(s.deps);
  expect(s.sent).toHaveLength(0);
});

test("a failed send is retried with backoff before giving up", async () => {
  const s = setup(2);
  await postShop(s.deps);
  expect(s.sent).toHaveLength(1);
  expect(s.sleeps).toEqual([5_000, 15_000]);
});

test("after 3 retries the run fails, and lastSentHash stays unchanged so the next run resends", async () => {
  const s = setup(4);
  await expect(postShop(s.deps)).rejects.toThrow("Discord 503");
  expect(s.sleeps).toEqual(SEND_RETRY_DELAYS_MS);
  expect(s.state.lastSentHash).toBeNull();
});

test("withRetries returns the first success", async () => {
  let calls = 0;
  const result = await withRetries(
    async () => {
      calls++;
      if (calls < 2) throw new Error("once");
      return "ok";
    },
    [1, 1],
    async () => {},
  );
  expect(result).toBe("ok");
  expect(calls).toBe(2);
});
