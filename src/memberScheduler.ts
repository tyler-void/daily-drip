// Members' scheduled runs (spec: Accounts).
//
// One tick a minute, like the owner's scheduler. A linked member is due 90 s after their shop
// resets, or at once when the bot has no shop for them yet (a new link, or a restart after the
// reset). Due members run one after another, a few seconds apart, so a reset doesn't sign many
// accounts in at the same moment: Riot rate-limits by IP. Each run takes the run lock (in `run`).
//
// - A dead sign-in (LoginDeadError): the member gets one "link again" message, then no more runs
//   until they link again, which clears the flag.
// - A rate limit or a Cloudflare block affects every account from this IP: the round stops there.
// - Anything else: that member retries later, per the owner's error table.

import { type AccountRegistry, type LinkedAccount, members } from "./accounts.ts";
import { log } from "./log.ts";
import { CloudflareBlockedError, RateLimitedError } from "./riot/auth.ts";
import { LoginDeadError } from "./riot/login.ts";
import { AFTER_RESET_MS, failurePolicy, TICK_MS } from "./scheduler.ts";
import type { ShopSnapshot } from "./shop.ts";

const MINUTE = 60_000;
/** Discord's error code when a user doesn't accept DMs: retrying before the next reset won't help. */
const CANNOT_DM = 50007;
export const MEMBER_GAP_MS = 5_000;

export interface MemberSchedulerDeps {
  accounts: () => AccountRegistry;
  /** One member's run (fetch, dedup, DM), under the run lock. Throws the run's error. */
  run: (account: LinkedAccount) => Promise<ShopSnapshot>;
  /** Tell a member once that they must /link again. */
  notifyLinkDead: (account: LinkedAccount) => Promise<void>;
  save: () => Promise<void>;
  now?: () => number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MemberScheduler {
  start(): void;
  stop(): void;
  /** One tick; start() calls it every minute. Exposed for tests. */
  tick(): Promise<void>;
  nextRunAt(discordUserId: string): number | undefined;
}

export function createMemberScheduler(deps: MemberSchedulerDeps): MemberScheduler {
  const now = () => deps.now?.() ?? Date.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const gapMs = deps.gapMs ?? MEMBER_GAP_MS;
  const next = new Map<string, number>();
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const afterReset = (snapshot: ShopSnapshot | null | undefined) => (snapshot ? Date.parse(snapshot.expiresAt) + AFTER_RESET_MS : 0);

  function dueAt(account: LinkedAccount): number {
    return next.get(account.discordUserId) ?? afterReset(account.member?.snapshot);
  }

  async function tick(): Promise<void> {
    if (busy) return; // a round can outlast a tick
    busy = true;
    try {
      const registry = deps.accounts();
      // Forget members who unlinked.
      for (const id of [...next.keys()]) if (!registry[id]) next.delete(id);
      const due = members(registry).filter((a) => a.member && !a.member.linkDeadNotified && now() >= dueAt(a));
      for (const [i, account] of due.entries()) {
        if (i > 0) await sleep(gapMs);
        if (await runOne(account)) break;
      }
    } finally {
      busy = false;
    }
  }

  /** Runs one member. Returns true when the round should stop (the whole IP is limited or blocked). */
  async function runOne(account: LinkedAccount): Promise<boolean> {
    const id = account.discordUserId;
    try {
      const snapshot = await deps.run(account);
      next.set(id, Math.max(afterReset(snapshot), now() + MINUTE));
      return false;
    } catch (err) {
      if (err instanceof LoginDeadError) {
        next.delete(id);
        log.warn("a member's Riot sign-in stopped working", { member: account.discordUsername });
        if (account.member && !account.member.linkDeadNotified) {
          await deps.notifyLinkDead(account).catch((e: unknown) => log.warn("could not tell the member to link again", { error: e }));
          // Set even if the message failed: retrying a dead sign-in every day helps no one.
          account.member.linkDeadNotified = true;
          await deps.save();
        }
        return false;
      }
      if ((err as { code?: number }).code === CANNOT_DM) {
        // The shop was fetched; only the DM failed. The channel note already told them. Wait for the next reset.
        next.set(id, Math.max(afterReset(account.member?.snapshot), now() + MINUTE));
        log.warn("a member doesn't accept DMs", { member: account.discordUsername });
        return false;
      }
      const { retryInMs } = failurePolicy(err, "");
      next.set(id, now() + retryInMs);
      log.warn("member run failed", { member: account.discordUsername, error: err, retryInMinutes: Math.round(retryInMs / MINUTE) });
      return err instanceof RateLimitedError || err instanceof CloudflareBlockedError;
    }
  }

  return {
    start() {
      void tick();
      timer = setInterval(() => void tick(), TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    nextRunAt: (discordUserId) => next.get(discordUserId),
  };
}
