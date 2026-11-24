// When to look for new matches (Match Recap Spec: Triggers). Presence decides when to poll, not
// when a match ended: the game client stays open between matches, so "Playing VALORANT" usually
// spans a whole session of several matches.
//
//   Playing:     while Discord shows the person playing VALORANT, poll every 4 min.
//   Stopped:     when that ends, poll at +2, +5 and +10 min (history lags the end of a match).
//   No presence: entries with trigger "poll" (no activity status, or off PC) poll every 20 min.
//   Sweep:       once a day at 04:00 local, check everyone's last matches; finds are marked late.
//
// A poll is one cheap history call; the poll function does the rest. A rate limit or a Cloudflare
// block pauses that data source (Riot pd or HenrikDev) until its Retry-After, default 1 h. Polls
// run one at a time. Nothing polls while nobody is playing, apart from "poll" entries and the sweep.

import { log } from "./log.ts";
import { CloudflareBlockedError, RateLimitedError } from "./riot/auth.ts";
import type { RosterEntry } from "./roster.ts";

const MINUTE = 60_000;
export const PLAYING_EVERY_MS = 4 * MINUTE;
export const AFTER_STOP_MS = [2 * MINUTE, 5 * MINUTE, 10 * MINUTE];
export const POLL_TRIGGER_EVERY_MS = 20 * MINUTE;
export const SWEEP_HOUR = 4;
export const TICK_MS = 30_000;
const DEFAULT_PAUSE_MS = 60 * MINUTE;

/** Which API an entry is polled through; a rate limit pauses that one only. */
export type Source = "pd" | "henrik";

export interface PollOptions {
  /** True for the daily sweep: anything found is marked "late". */
  sweep: boolean;
}

export interface RecapSchedulerDeps {
  /** The roster's enabled entries. */
  entries: () => RosterEntry[];
  sourceOf: (entry: RosterEntry) => Source;
  /** One poll for one entry. Throws the shared errors (rate limit, Cloudflare) to pause its source. */
  poll: (entry: RosterEntry, options: PollOptions) => Promise<void>;
  now?: () => number;
  /** Local hour of the day for the sweep; tests pass a function. */
  localHour?: (ms: number) => number;
  /** Local date ("2026-11-25") of a moment, so the sweep runs once a day. */
  localDay?: (ms: number) => string;
}

export interface RecapScheduler {
  /** A presence update: is this Discord user playing VALORANT right now? */
  presence(discordUserId: string, playing: boolean): void;
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  /** For logs and tests. */
  status(discordUserId: string): { playing: boolean; nextPollAt: number | null; afterStop: number[] };
  pausedUntil(source: Source): number;
}

interface PersonState {
  playing: boolean;
  nextPollAt: number | null;
  afterStop: number[];
}

export function createRecapScheduler(deps: RecapSchedulerDeps): RecapScheduler {
  const now = () => deps.now?.() ?? Date.now();
  const localHour = deps.localHour ?? ((ms: number) => new Date(ms).getHours());
  const localDay = deps.localDay ?? ((ms: number) => new Date(ms).toLocaleDateString("sv-SE"));
  const people = new Map<string, PersonState>();
  const paused: Record<Source, number> = { pd: 0, henrik: 0 };
  let lastSweepDay: string | null = null;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const state = (id: string): PersonState => {
    let s = people.get(id);
    if (!s) {
      s = { playing: false, nextPollAt: null, afterStop: [] };
      people.set(id, s);
    }
    return s;
  };

  async function runPoll(entry: RosterEntry, options: PollOptions): Promise<boolean> {
    const source = deps.sourceOf(entry);
    if (now() < paused[source]) return false;
    try {
      await deps.poll(entry, options);
    } catch (err) {
      if (err instanceof RateLimitedError || err instanceof CloudflareBlockedError) {
        const ms = err instanceof RateLimitedError ? Math.max(MINUTE, err.retryAfterSeconds * 1000) : DEFAULT_PAUSE_MS;
        paused[source] = now() + ms;
        log.warn("recap polling paused", { source, minutes: Math.round(ms / MINUTE), error: err });
      } else {
        // Anything else: this poll is lost; the next one, or the sweep, finds the match.
        log.warn("recap poll failed", { member: entry.riotName ?? entry.discordUserId, error: err });
      }
    }
    return true;
  }

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const t = now();
      const entries = deps.entries();
      const activeIds = new Set(entries.map((e) => e.discordUserId));
      for (const id of [...people.keys()]) if (!activeIds.has(id)) people.delete(id);

      // The sweep, once a day at SWEEP_HOUR or later (a bot that was down at 04:00 sweeps when it's back).
      const day = localDay(t);
      if (lastSweepDay === null) lastSweepDay = localHour(t) >= SWEEP_HOUR ? day : null;
      if (lastSweepDay !== day && localHour(t) >= SWEEP_HOUR) {
        lastSweepDay = day;
        log.info("recap sweep", { entries: entries.length });
        for (const entry of entries) await runPoll(entry, { sweep: true });
        return;
      }

      for (const entry of entries) {
        const s = state(entry.discordUserId);
        let due = false;
        if (entry.trigger === "poll") {
          if (s.nextPollAt === null) s.nextPollAt = t + POLL_TRIGGER_EVERY_MS;
          if (t >= s.nextPollAt) {
            due = true;
            s.nextPollAt = t + POLL_TRIGGER_EVERY_MS;
          }
        } else {
          if (s.playing && s.nextPollAt !== null && t >= s.nextPollAt) {
            due = true;
            s.nextPollAt = t + PLAYING_EVERY_MS;
          }
          if (s.afterStop.some((at) => t >= at)) {
            due = true;
            s.afterStop = s.afterStop.filter((at) => t < at);
          }
        }
        if (due) await runPoll(entry, { sweep: false });
      }
    } finally {
      busy = false;
    }
  }

  return {
    presence(discordUserId, playing) {
      const entry = deps.entries().find((e) => e.discordUserId === discordUserId);
      if (!entry || entry.trigger !== "presence") return;
      const s = state(discordUserId);
      if (playing === s.playing) return; // compare with our own record, not discord.js's oldPresence
      s.playing = playing;
      if (playing) {
        s.nextPollAt = now() + PLAYING_EVERY_MS;
        s.afterStop = [];
        log.debug("recap: playing", { member: entry.riotName ?? discordUserId });
      } else {
        s.nextPollAt = null;
        s.afterStop = AFTER_STOP_MS.map((ms) => now() + ms);
        log.debug("recap: stopped playing", { member: entry.riotName ?? discordUserId });
      }
    },
    tick,
    start() {
      void tick();
      timer = setInterval(() => void tick(), TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status(id) {
      const s = people.get(id);
      return s ? { playing: s.playing, nextPollAt: s.nextPollAt, afterStop: [...s.afterStop] } : { playing: false, nextPollAt: null, afterStop: [] };
    },
    pausedUntil: (source) => paused[source],
  };
}

/** Does a discord.js presence show VALORANT being played? Compared case-insensitively (spec). */
export function isPlayingValorant(activities: readonly { type: number; name: string }[] | null | undefined): boolean {
  // ActivityType.Playing is 0.
  return (activities ?? []).some((a) => a.type === 0 && a.name.trim().toLowerCase() === "valorant");
}
