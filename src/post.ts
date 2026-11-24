// One scheduled run: fetch the shop and post it, unless this exact shop was already sent
// (spec: Schedule & notifications). Everything happens under the run lock.

import type { WithLock } from "./lock.ts";
import { log } from "./log.ts";
import type { Notifier } from "./notify/notifier.ts";
import type { ShopSnapshot } from "./shop.ts";
import type { State } from "./state.ts";
import { matchWishlist } from "./wishlist.ts";

/** Spec: a failed Discord send is retried 3 times with backoff (discord.js handles 429s itself). */
export const SEND_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/** What a post reads and writes: the owner's state, or a member's record. */
export interface PostState {
  lastSentHash: string | null;
  wishlist: string[] | null;
}

export interface PostDeps<S extends PostState = State> {
  state: S;
  save: (state: S) => Promise<void>;
  withLock: WithLock;
  /** fetchShop with its dependencies. */
  fetchShop: () => Promise<ShopSnapshot>;
  notifier: Notifier;
  /** Runs after every successful fetch, e.g. reloading the autocomplete skin list. */
  afterFetch?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export async function postShop<S extends PostState>(deps: PostDeps<S>): Promise<ShopSnapshot> {
  return deps.withLock(async () => {
    const snapshot = await deps.fetchShop();
    await deps.afterFetch?.();
    if (snapshot.hash === deps.state.lastSentHash) {
      log.info("this shop was already sent; nothing to post");
      return snapshot;
    }
    const hits = matchWishlist(snapshot.offers, deps.state.wishlist ?? []);
    await withRetries(() => deps.notifier.sendShop(snapshot, hits), SEND_RETRY_DELAYS_MS, deps.sleep);
    // Spec: lastSentHash is written only after Discord accepts the message.
    deps.state.lastSentHash = snapshot.hash;
    await deps.save(deps.state);
    log.info("shop posted", { offers: snapshot.offers.map((o) => o.name), wishlistHits: hits.map((h) => h.name) });
    return snapshot;
  });
}

export async function withRetries<T>(fn: () => Promise<T>, delaysMs: number[], sleep = defaultSleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = delaysMs[attempt];
      if (delay === undefined) throw err;
      log.warn("send failed; retrying", { inSeconds: delay / 1000, error: err });
      await sleep(delay);
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
