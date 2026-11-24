// One recap poll for one roster entry (Match Recap Spec: Triggers, Dedup and grouping, Error
// handling). Called by the recap scheduler; everything outside is injected, so it is testable.
//
//   1. New matches: the entry's newest matches, newer than the last one looked at, in a recap
//      queue, not older than 24 h (or than the entry itself), and not already posted.
//   2. Details: E11 for a linked entry (with their own session), H2 for a followed one. A match
//      Riot is still processing is retried on the next poll, and given up after 30 min.
//   3. One recap per match, for every roster member in it: whoever's poll finds it first builds it.
//   4. RR for competitive matches: E12 with each linked player's own session, H3 for followed
//      ones. Missing RR is "…" and filled in later by editing the post; after 15 min it's dropped.
//   5. A match is recorded only after Discord accepted the post.

import type { CatalogNames } from "./catalog.ts";
import type { Henrik } from "./henrik.ts";
import { log } from "./log.ts";
import { type RrState, recapMessage } from "./notify/recapMessage.ts";
import type { DiscordMessage } from "./notify/discord.ts";
import type { MatchRecap } from "./recap.ts";
import type { Session } from "./riot/auth.ts";
import { type HistoryEntry, MatchNotReadyError, type RrUpdate } from "./riot/matches.ts";
import { BadClaimsError } from "./riot/store.ts";
import { active, findByPuuid, refreshRiotName, type RosterEntry } from "./roster.ts";
import { MAX_POSTED_MATCHES, type PostedMatch, type RecapState } from "./state.ts";

const MINUTE = 60_000;
export const GIVE_UP_NOT_READY_MS = 30 * MINUTE;
export const GIVE_UP_RR_MS = 15 * MINUTE;
export const MAX_AGE_MS = 24 * 60 * MINUTE;
export const DEFAULT_QUEUES = ["competitive", "unrated", "swiftplay"];

/** Riot pd with a linked entry's own session. */
export interface PdApi {
  session(entry: RosterEntry): Promise<Session>;
  /** Forget a stale session (after 401 / BAD_CLAIMS), so the next one is fresh. */
  dropSession(entry: RosterEntry): void;
  history(session: Session, count: number): Promise<HistoryEntry[]>;
  details(session: Session, matchId: string): Promise<MatchRecap>;
  rr(session: Session): Promise<RrUpdate[]>;
}

export interface RecapPollDeps {
  recap: RecapState;
  save: () => Promise<void>;
  queues: string[];
  names: () => CatalogNames | null;
  pd: PdApi | null;
  henrik: Henrik | null;
  /** Posts in the recap channel; returns the message ID. */
  post: (message: DiscordMessage) => Promise<string>;
  edit: (messageId: string, message: DiscordMessage) => Promise<void>;
  now?: () => number;
}

export interface RecapPoller {
  poll(entry: RosterEntry, options: { sweep: boolean }): Promise<void>;
}

export function createRecapPoller(deps: RecapPollDeps): RecapPoller {
  const now = () => deps.now?.() ?? Date.now();
  /** Match ID -> when it was first seen not ready (in memory: a restart just starts the 30 min again). */
  const notReadySince = new Map<string, number>();
  /** Match ID -> the recap last posted, to rebuild the message when RR arrives. */
  const recaps = new Map<string, MatchRecap>();

  /** The Discord user of each tracked PUUID, from the roster (the link between the two halves). */
  function discordIdsOf(puuids: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const puuid of puuids) {
      const entry = findByPuuid(deps.recap.roster, puuid);
      if (entry) out[puuid] = entry.discordUserId;
    }
    return out;
  }

  /** Runs `fn` with the entry's pd session; on a stale session, drops it and retries once (spec). */
  async function withPd<T>(entry: RosterEntry, fn: (session: Session) => Promise<T>): Promise<T> {
    const pd = deps.pd as PdApi;
    try {
      return await fn(await pd.session(entry));
    } catch (err) {
      if (!(err instanceof BadClaimsError)) throw err;
      pd.dropSession(entry);
      return await fn(await pd.session(entry));
    }
  }

  /** The entry's newest matches, newest first, with details for each new one (H2 gives them at once). */
  async function newMatches(entry: RosterEntry, sweep: boolean): Promise<{ matchId: string; startedAt: string; queue: string; load: () => Promise<MatchRecap | null> }[]> {
    const count = sweep ? 5 : 3;
    if (entry.tier === "linked") {
      if (!deps.pd) return [];
      const history = await withPd(entry, (s) => deps.pd!.history(s, count));
      return history.map((h) => ({ ...h, load: () => withPd(entry, (s) => deps.pd!.details(s, h.matchId)) }));
    }
    if (!deps.henrik || !entry.region) return [];
    const match = await deps.henrik.newestMatch(entry.region, entry.puuid);
    return match ? [{ matchId: match.matchId, startedAt: match.startedAt, queue: match.queue, load: async () => match }] : [];
  }

  async function rrFor(entry: RosterEntry, matchId: string): Promise<RrUpdate | null> {
    const updates = entry.tier === "linked" ? (deps.pd ? await withPd(entry, (s) => deps.pd!.rr(s)) : []) : deps.henrik && entry.region ? await deps.henrik.rrHistory(entry.region, entry.puuid) : [];
    return updates.find((u) => u.matchId === matchId) ?? null;
  }

  /** RR for every tracked player in a competitive match; "pending" where it isn't out yet. */
  async function collectRr(recap: MatchRecap, tracked: string[], postedAt: number): Promise<Record<string, RrState>> {
    const result: Record<string, RrState> = {};
    if (recap.queue !== "competitive") return result;
    for (const puuid of tracked) {
      const entry = findByPuuid(deps.recap.roster, puuid);
      let rr: RrUpdate | null = null;
      try {
        rr = entry ? await rrFor(entry, recap.matchId) : null;
      } catch (err) {
        log.debug("recap: RR not available yet", { error: err });
      }
      result[puuid] = rr ?? (now() - postedAt >= GIVE_UP_RR_MS ? "none" : "pending");
    }
    return result;
  }

  async function postMatch(recap: MatchRecap, late: boolean): Promise<void> {
    const roster = deps.recap.roster;
    const tracked = recap.players.filter((p) => active(roster).some((e) => e.puuid === p.puuid)).map((p) => p.puuid);
    if (tracked.length === 0) return;
    for (const p of recap.players) if (tracked.includes(p.puuid)) refreshRiotName(roster, p.puuid, p.riotName);
    const rr = await collectRr(recap, tracked, now());
    const message = recapMessage({ recap, tracked, rr, names: deps.names(), late, discordIds: discordIdsOf(tracked) });
    const messageId = await deps.post(message);
    const posted: PostedMatch = {
      matchId: recap.matchId,
      messageId,
      postedAt: new Date(now()).toISOString(),
      rrPending: Object.entries(rr).flatMap(([puuid, state]) => (state === "pending" ? [puuid] : [])),
      tracked,
      late,
    };
    deps.recap.postedMatches = [posted, ...deps.recap.postedMatches].slice(0, MAX_POSTED_MATCHES);
    recaps.set(recap.matchId, recap);
    await deps.save();
    log.info("recap posted", { match: recap.matchId.slice(0, 8), queue: recap.queue, tracked: tracked.length, late });
  }

  /** Posted matches still waiting for RR: try again, edit when it arrives or when giving up. */
  async function fillPendingRr(): Promise<void> {
    for (const posted of deps.recap.postedMatches) {
      if (posted.rrPending.length === 0) continue;
      const recap = recaps.get(posted.matchId);
      if (!recap) {
        posted.rrPending = []; // the bot restarted: the recap isn't in memory any more; leave the post as it is
        continue;
      }
      const rr = await collectRr(recap, posted.tracked, Date.parse(posted.postedAt));
      const stillPending = Object.entries(rr).flatMap(([puuid, state]) => (state === "pending" ? [puuid] : []));
      if (stillPending.length === posted.rrPending.length) continue;
      await deps.edit(posted.messageId, recapMessage({ recap, tracked: posted.tracked, rr, names: deps.names(), late: posted.late, discordIds: discordIdsOf(posted.tracked) }));
      posted.rrPending = stillPending;
      await deps.save();
    }
  }

  return {
    async poll(entry, { sweep }) {
      const lastSeen = deps.recap.lastSeenMatch[entry.puuid];
      const oldest = Math.max(now() - MAX_AGE_MS, Date.parse(entry.addedAt) || 0);
      const posted = new Set(deps.recap.postedMatches.map((p) => p.matchId));
      const history = await newMatches(entry, sweep);

      // Newest first: stop at the last one already looked at (a sweep looks at all of them).
      const fresh: typeof history = [];
      for (const h of history) {
        if (!sweep && h.matchId === lastSeen) break;
        fresh.push(h);
      }
      let newestHandled: string | null = null;
      for (const h of fresh.reverse()) {
        const wanted = deps.queues.includes(h.queue) && Date.parse(h.startedAt) >= oldest && !posted.has(h.matchId);
        if (wanted) {
          let recap: MatchRecap | null = null;
          try {
            recap = await h.load();
          } catch (err) {
            if (!(err instanceof MatchNotReadyError)) throw err;
          }
          if (!recap || !recap.completed) {
            const since = notReadySince.get(h.matchId) ?? now();
            notReadySince.set(h.matchId, since);
            if (now() - since < GIVE_UP_NOT_READY_MS) break; // try again next poll; don't move past it
            log.warn("recap: giving up on a match Riot never finished", { match: h.matchId.slice(0, 8) });
          } else {
            notReadySince.delete(h.matchId);
            await postMatch(recap, sweep);
          }
        }
        newestHandled = h.matchId;
      }
      if (newestHandled && !sweep) {
        deps.recap.lastSeenMatch[entry.puuid] = newestHandled;
        await deps.save();
      }
      await fillPendingRr();
    },
  };
}
