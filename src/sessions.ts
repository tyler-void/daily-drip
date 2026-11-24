// In-memory session cache for recaps (Match Recap Spec: Session reuse).
//
// The shop signs in from scratch on every run; recap polls must not. The owner's sign-in (E1)
// rotates their cookie on every call, so polling every 4 minutes would rotate it 15 times an hour.
// Each person's Session is kept here, in memory only, for SESSION_TTL_MS (tokens live about an
// hour), and dropped early on a 401 or BAD_CLAIMS. Nothing goes to state.json.
//
// The cache doesn't lock: `mint` must take the run lock itself, so a shop run and a recap never
// refresh the same credentials at once. Concurrent gets for one key share a single mint.

import type { Session } from "./riot/auth.ts";

/** 50 minutes: under the access token's hour, with room for a poll that starts just before expiry. */
export const SESSION_TTL_MS = 50 * 60_000;

export interface SessionCache {
  /** The cached session for `key` while it is fresh; otherwise `mint()`'s, which is then cached. */
  get(key: string, mint: () => Promise<Session>): Promise<Session>;
  /** Store a session minted elsewhere, e.g. the shop's, so recaps can reuse it. */
  put(key: string, session: Session): void;
  /** Forget a session, after a 401 or BAD_CLAIMS. */
  drop(key: string): void;
  /** How many fresh sessions are held (for logs and tests). */
  size(): number;
}

export function createSessionCache(options: { ttlMs?: number; now?: () => number } = {}): SessionCache {
  const ttl = options.ttlMs ?? SESSION_TTL_MS;
  const now = options.now ?? Date.now;
  const held = new Map<string, { session: Session; mintedAt: number }>();
  const minting = new Map<string, Promise<Session>>();

  const fresh = (key: string) => {
    const entry = held.get(key);
    if (entry && now() - entry.mintedAt < ttl) return entry.session;
    held.delete(key);
    return null;
  };

  return {
    async get(key, mint) {
      const cached = fresh(key);
      if (cached) return cached;
      const inFlight = minting.get(key);
      if (inFlight) return inFlight;
      const p = mint()
        .then((session) => {
          held.set(key, { session, mintedAt: now() });
          return session;
        })
        .finally(() => minting.delete(key));
      minting.set(key, p);
      return p;
    },
    put(key, session) {
      held.set(key, { session, mintedAt: now() });
    },
    drop(key) {
      held.delete(key);
    },
    size() {
      return [...held.keys()].filter((k) => fresh(k) !== null).length;
    },
  };
}
