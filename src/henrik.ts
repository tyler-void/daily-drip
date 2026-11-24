// HenrikDev API for the followed tier (Match Recap Spec: HenrikDev integration).
//
//   H1 /valorant/v2/account/{name}/{tag}                      Riot ID -> PUUID and region
//   H2 /valorant/v4/by-puuid/matches/{region}/pc/{puuid}      newest match, every player's stats
//   H3 /valorant/v2/by-puuid/mmr-history/{region}/pc/{puuid}  RR change per competitive match
//
// The key goes in the Authorization header and is registered with the log redactor. Calls share
// one budget: HenrikDev allows 30 units a minute on a Basic key, and one call costs 1 to 3 units
// (the Riot fetches it makes for us count too; spike S3 measured H1 3, H2 cold 2 and warm 1, H3 2).
// The bot spends at most 20 a minute, and trusts X-RateLimit-Remaining and Retry-After over its
// own count.

import type { Http } from "./http.ts";
import { addSecret, log } from "./log.ts";
import { type MatchRecap, recapFromHenrikMatch } from "./recap.ts";
import { RateLimitedError, UnexpectedResponseError } from "./riot/auth.ts";
import type { RrUpdate } from "./riot/matches.ts";

export const HENRIK_BASE = "https://api.henrikdev.xyz";
/** The bot's own ceiling per minute, under HenrikDev's 30. */
export const BUDGET_PER_MINUTE = 20;
/** Assume the most a call can cost until HenrikDev's headers say otherwise. */
const WORST_CASE_COST = 3;
/** Longer waits than this end the call with a RateLimitedError instead, so the scheduler can pause. */
const MAX_WAIT_MS = 120_000;

/** 401 or 403: the key is missing, wrong or revoked. Alert the owner once; pause the followed tier. */
export class HenrikAuthError extends Error {
  name = "HenrikAuthError";
}

export interface HenrikAccount {
  puuid: string;
  name: string;
  tag: string;
  region: string;
}

export interface HenrikDeps {
  http: Http;
  key: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Henrik {
  /** H1. Null when no Riot account has that ID. */
  account(riotId: string): Promise<HenrikAccount | null>;
  /** H2. The newest match, or null when the player has none. */
  newestMatch(region: string, puuid: string): Promise<MatchRecap | null>;
  /** H2. The newest `size` matches (1-10), newest first. */
  matches(region: string, puuid: string, size: number): Promise<MatchRecap[]>;
  /** H3. Newest first. */
  rrHistory(region: string, puuid: string): Promise<RrUpdate[]>;
}

export function createHenrik(deps: HenrikDeps): Henrik {
  addSecret(deps.key);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Units spent in the current minute, and HenrikDev's own view when it has told us.
  let windowStart = now();
  let spent = 0;
  let blockedUntil = 0;

  async function reserve(): Promise<void> {
    for (;;) {
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        spent = 0;
      }
      const waitFor = Math.max(blockedUntil - t, spent + WORST_CASE_COST > BUDGET_PER_MINUTE ? windowStart + 60_000 - t : 0);
      if (waitFor <= 0) break;
      if (waitFor > MAX_WAIT_MS) throw new RateLimitedError("HenrikDev", Math.ceil(waitFor / 1000));
      await sleep(waitFor);
    }
    spent += WORST_CASE_COST;
  }

  /** After a call, HenrikDev's headers correct the local count. */
  function settle(res: Response): void {
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining) && res.headers.has("x-ratelimit-remaining")) {
      // Their window is the real one: ours ends when theirs resets.
      if (Number.isFinite(reset) && res.headers.has("x-ratelimit-reset")) windowStart = now() + reset * 1000 - 60_000;
      // Keep our ceiling 10 below theirs: spent = 30 - remaining - 10.
      spent = Math.max(0, 30 - remaining - (30 - BUDGET_PER_MINUTE));
      if (remaining < WORST_CASE_COST && Number.isFinite(reset)) blockedUntil = Math.max(blockedUntil, now() + reset * 1000);
    }
  }

  async function get(path: string, what: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
    for (let attempt = 0; ; attempt++) {
      await reserve();
      const res = await deps.http.request(HENRIK_BASE + path, { headers: { Authorization: deps.key, Accept: "application/json" }, timeoutMs: 30_000 });
      settle(res);
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 60;
        blockedUntil = Math.max(blockedUntil, now() + retryAfter * 1000);
        if (attempt >= 1 || retryAfter * 1000 > MAX_WAIT_MS) throw new RateLimitedError(what, retryAfter);
        log.warn("HenrikDev rate limit; waiting", { what, retryAfterSeconds: retryAfter });
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new HenrikAuthError(`${what} answered ${res.status}: the HenrikDev key is missing or invalid`);
      let body: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = await res.json();
        if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
      } catch {
        // handled by the callers
      }
      return { status: res.status, body };
    }
  }

  async function matches(region: string, puuid: string, size: number): Promise<MatchRecap[]> {
    const n = Math.min(10, Math.max(1, Math.floor(size)));
    const { status, body } = await get(`/valorant/v4/by-puuid/matches/${encodeURIComponent(region)}/pc/${encodeURIComponent(puuid)}?size=${n}`, "H2 matches");
    if (status === 404) return [];
    if (status !== 200 || !Array.isArray(body?.data)) throw new UnexpectedResponseError(`H2 matches returned ${status}`);
    return body.data.flatMap((m: unknown) => recapFromHenrikMatch(m) ?? []);
  }

  return {
    async account(riotId) {
      const [name, tag] = splitRiotId(riotId);
      if (!name || !tag) return null;
      const { status, body } = await get(`/valorant/v2/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, "H1 account");
      if (status === 404) return null;
      const data = body?.data as Record<string, unknown> | undefined;
      if (status !== 200 || typeof data?.puuid !== "string") throw new UnexpectedResponseError(`H1 account returned ${status}`);
      return {
        puuid: data.puuid,
        name: typeof data.name === "string" ? data.name : name,
        tag: typeof data.tag === "string" ? data.tag : tag,
        region: typeof data.region === "string" ? data.region : "ap",
      };
    },

    async newestMatch(region, puuid) {
      return (await matches(region, puuid, 1))[0] ?? null;
    },

    matches,

    async rrHistory(region, puuid) {
      const { status, body } = await get(`/valorant/v2/by-puuid/mmr-history/${encodeURIComponent(region)}/pc/${encodeURIComponent(puuid)}`, "H3 mmr history");
      if (status !== 200) throw new UnexpectedResponseError(`H3 mmr history returned ${status}`);
      const data = body?.data as Record<string, unknown> | undefined;
      const history = Array.isArray(data?.history) ? data.history : [];
      return history.flatMap((h: Record<string, unknown>): RrUpdate[] => {
        if (typeof h?.match_id !== "string" || typeof h.last_change !== "number") return [];
        return [
          {
            matchId: h.match_id,
            earned: h.last_change,
            after: typeof h.rr === "number" ? h.rr : 0,
            tierAfter: tierId(h.tier),
            tierBefore: tierId(h.tier_before_update),
          },
        ];
      });
    },
  };
}

/** "name#tag", allowing spaces in the name; the tag is after the last "#". */
export function splitRiotId(riotId: string): [string, string] | [null, null] {
  const text = riotId.trim();
  const hash = text.lastIndexOf("#");
  if (hash <= 0 || hash === text.length - 1) return [null, null];
  return [text.slice(0, hash).trim(), text.slice(hash + 1).trim()];
}

function tierId(value: unknown): number {
  if (typeof value === "number") return value;
  const id = typeof value === "object" && value !== null ? (value as Record<string, unknown>).id : undefined;
  return typeof id === "number" ? id : 0;
}
