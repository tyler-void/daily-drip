// Scheduler (spec: Schedule & notifications; Error handling).
//
// Instead of one long timer, a tick every minute compares the wall clock with the next run
// time. Long timers stop counting while a machine sleeps and fire late; a tick catches up
// within a minute of waking. Each tick:
//   1. dead-man switch: no successful run for 26 h -> one warning;
//   2. while the cookie is dead: run only once the cookie file changes;
//   3. otherwise run when the next run time has come.
// A successful run arms the next one for the reset + 90 s; a failed run arms a retry with the
// delay from the error table, and some failures alert the owner once.

import { readFile } from "node:fs/promises";
import { BAD_CLAIMS_TEXT, blockedText, cookieDeadText, deadManText } from "./alerts.ts";
import { hashCookieFile } from "./cookies.ts";
import { log, redact } from "./log.ts";
import type { Notifier } from "./notify/notifier.ts";
import { CloudflareBlockedError, CookieDeadError, RateLimitedError } from "./riot/auth.ts";
import { BadClaimsError, MaintenanceError } from "./riot/store.ts";
import type { ShopSnapshot } from "./shop.ts";
import type { AlertFlags, State } from "./state.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const TICK_MS = MINUTE;
/** Spec: arm for the reset + 90 s, so Riot has rotated the shop. */
export const AFTER_RESET_MS = 90_000;
export const DEAD_MAN_MS = 26 * HOUR;
export const DEFAULT_RETRY_MS = 30 * MINUTE;

export interface FailurePolicy {
  retryInMs: number;
  alert?: { flag: keyof AlertFlags; text: string };
}

/** The spec's Error handling table: when to retry, and which failures alert the owner (once). */
export function failurePolicy(err: unknown, cookieFile: string): FailurePolicy {
  if (err instanceof CookieDeadError) {
    // Once the alert is out, the scheduler waits for a new cookie file instead of this timer.
    return { retryInMs: DEFAULT_RETRY_MS, alert: { flag: "cookieDeadNotified", text: cookieDeadText(cookieFile) } };
  }
  if (err instanceof CloudflareBlockedError) return { retryInMs: HOUR, alert: { flag: "blockedNotified", text: blockedText(err.message) } };
  if (err instanceof RateLimitedError) return { retryInMs: Math.max(MINUTE, err.retryAfterSeconds * 1000) };
  if (err instanceof MaintenanceError) return { retryInMs: DEFAULT_RETRY_MS };
  if (err instanceof BadClaimsError) return { retryInMs: DEFAULT_RETRY_MS, alert: { flag: "badClaimsNotified", text: BAD_CLAIMS_TEXT } };
  return { retryInMs: DEFAULT_RETRY_MS }; // network, valorant-api.com, Discord, anything else
}

export interface SchedulerDeps {
  state: State;
  save: (state: State) => Promise<void>;
  /** One scheduled run (postShop). */
  run: () => Promise<ShopSnapshot>;
  notifier: Pick<Notifier, "sendAlert">;
  cookieFile: string;
  /** Called after each successful run: the HEALTHCHECK_URL ping. */
  heartbeat?: () => Promise<void>;
  now?: () => number;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** One tick; start() calls it every minute. Exposed for tests. */
  tick(): Promise<void>;
  nextRunAt(): number;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = () => deps.now?.() ?? Date.now();
  const startedAt = now();
  let nextRunAt = 0; // spec: on start, run once immediately
  let busy = false;
  let lastError: string | null = null;
  /** The cookie-file hash a dead-cookie retry already tried, so a bad new file is not retried every minute. */
  let triedCookieHash: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    if (busy) return; // a run can outlast a tick
    busy = true;
    try {
      await checkDeadMan();
      if (deps.state.flags.cookieDeadNotified) {
        const hash = await cookieFileHash();
        if (hash === null || hash === deps.state.cookie?.sourceHash || hash === triedCookieHash) return;
        log.info("the cookie file changed; running now");
        triedCookieHash = hash;
        nextRunAt = now();
      }
      if (now() < nextRunAt) return;
      await runNow();
    } finally {
      busy = false;
    }
  }

  async function runNow(): Promise<void> {
    try {
      const snapshot = await deps.run();
      lastError = null;
      triedCookieHash = null;
      // At least a minute ahead, in case Riot answers with an already-expired shop.
      nextRunAt = Math.max(Date.parse(snapshot.expiresAt) + AFTER_RESET_MS, now() + MINUTE);
      log.info("next run scheduled", { at: localTime(nextRunAt) });
      if (deps.heartbeat) await deps.heartbeat().catch((err: unknown) => log.warn("heartbeat ping failed", { error: err }));
    } catch (err) {
      const policy = failurePolicy(err, deps.cookieFile);
      lastError = err instanceof Error ? err.message : String(err);
      nextRunAt = now() + policy.retryInMs;
      log.warn("run failed", { error: err, retryAt: localTime(nextRunAt) });
      if (policy.alert) await alertOnce(policy.alert.flag, policy.alert.text);
    }
  }

  async function checkDeadMan(): Promise<void> {
    const { flags, lastSuccessAt } = deps.state;
    // The cookie-dead alert already says why nothing arrives.
    if (flags.deadManNotified || flags.cookieDeadNotified) return;
    const since = now() - (lastSuccessAt ? Date.parse(lastSuccessAt) : startedAt);
    if (since >= DEAD_MAN_MS) await alertOnce("deadManNotified", deadManText(since, lastError));
  }

  /** Send an alert unless its flag is set; set the flag only once the alert went out. */
  async function alertOnce(flag: keyof AlertFlags, text: string): Promise<void> {
    if (deps.state.flags[flag]) return;
    try {
      await deps.notifier.sendAlert(redact(text));
    } catch (err) {
      log.error("could not send an alert; will try again on the next failure", { flag, error: err });
      return;
    }
    deps.state.flags[flag] = true;
    await deps.save(deps.state);
    log.info("alert sent", { flag });
  }

  async function cookieFileHash(): Promise<string | null> {
    try {
      return hashCookieFile(await readFile(deps.cookieFile, "utf8"));
    } catch {
      return null;
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
    nextRunAt: () => nextRunAt,
  };
}

function localTime(ms: number): string {
  return new Date(ms).toLocaleString("sv-SE", { hour12: false });
}
