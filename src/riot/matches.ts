// Match history (E10), match details (E11) and competitive updates (E12) for recaps
// (Match Recap Spec: Riot pd endpoints). Same 4 game headers as the storefront. Response shapes
// confirmed by spike S2 on 2026-11-25.

import type { Http } from "../http.ts";
import { log } from "../log.ts";
import { type MatchRecap, recapFromMatchDetails } from "../recap.ts";
import { parseRetryAfter, RateLimitedError, type Session, UnexpectedResponseError } from "./auth.ts";
import { BadClaimsError, gameHeaders, MaintenanceError } from "./store.ts";

export interface HistoryEntry {
  matchId: string;
  startedAt: string;
  /** "competitive", "unrated", "swiftplay", "deathmatch", ... (S2 also saw "ggteam", "hurm"). */
  queue: string;
}

export interface RrUpdate {
  matchId: string;
  /** RR gained (negative when lost). */
  earned: number;
  /** RR within the new tier. */
  after: number;
  tierAfter: number;
  tierBefore: number;
}

/** E11 has no such match yet (404): retried on the next poll, given up after 30 min (spec). */
export class MatchNotReadyError extends Error {
  name = "MatchNotReadyError";
}

const pd = (session: Session) => `https://pd.${session.shard}.a.pvp.net`;

export const historyUrl = (session: Session, puuid: string, count = 5) =>
  `${pd(session)}/match-history/v1/history/${puuid}?startIndex=0&endIndex=${count}`;
export const detailsUrl = (session: Session, matchId: string) => `${pd(session)}/match-details/v1/matches/${matchId}`;
export const nameServiceUrl = (session: Session) => `${pd(session)}/name-service/v2/players`;
export const competitiveUpdatesUrl = (session: Session, puuid: string, count = 5) =>
  `${pd(session)}/mmr/v1/players/${puuid}/competitiveupdates?startIndex=0&endIndex=${count}&queue=competitive`;

/** E10: a player's newest matches, newest first. With the owner's session, `puuid` is normally the owner's own. */
export async function fetchHistory(http: Http, session: Session, clientVersion: string, puuid = session.puuid, count = 5): Promise<HistoryEntry[]> {
  const body = await get(http, historyUrl(session, puuid, count), session, clientVersion, "E10 match history");
  const history = Array.isArray(body.History) ? body.History : [];
  return history.flatMap((h: Record<string, unknown>): HistoryEntry[] => {
    if (typeof h?.MatchID !== "string") return [];
    return [{ matchId: h.MatchID, startedAt: new Date(typeof h.GameStartTime === "number" ? h.GameStartTime : 0).toISOString(), queue: typeof h.QueueID === "string" ? h.QueueID : "" }];
  });
}

/**
 * E11: everything in a recap. Throws MatchNotReadyError while Riot doesn't have it yet. E11 leaves
 * players' names blank, so they are filled in from the name service; if that fails, the recap goes
 * out without them.
 */
export async function fetchMatchDetails(http: Http, session: Session, clientVersion: string, matchId: string): Promise<MatchRecap> {
  const body = await get(http, detailsUrl(session, matchId), session, clientVersion, "E11 match details");
  const recap = recapFromMatchDetails(body);
  if (!recap) throw new UnexpectedResponseError("E11 match details: not a match");
  const missing = recap.players.filter((p) => !p.riotName).map((p) => p.puuid);
  if (missing.length) {
    const names = await fetchNames(http, session, clientVersion, missing).catch((err: unknown) => {
      log.warn("could not look up the players' names", { error: err });
      return {} as Record<string, string>;
    });
    for (const p of recap.players) p.riotName ??= names[p.puuid] ?? null;
  }
  return recap;
}

/** E13, the name service: Riot IDs ("Name#TAG") by PUUID. Players Riot returns no name for are left out. */
export async function fetchNames(http: Http, session: Session, clientVersion: string, puuids: string[]): Promise<Record<string, string>> {
  const res = await http.request(nameServiceUrl(session), {
    method: "PUT",
    headers: { ...gameHeaders(session, clientVersion), "Content-Type": "application/json" },
    body: JSON.stringify(puuids),
    timeoutMs: 15_000,
  });
  if (res.status === 429) throw new RateLimitedError("E13 name service", parseRetryAfter(res.headers.get("retry-after")));
  if (res.status !== 200) throw new UnexpectedResponseError(`E13 name service returned ${res.status}`);
  const body: unknown = await res.json();
  const out: Record<string, string> = {};
  for (const entry of Array.isArray(body) ? body : []) {
    const e = entry as Record<string, unknown>;
    if (typeof e?.Subject !== "string" || typeof e.GameName !== "string" || !e.GameName) continue;
    out[e.Subject] = typeof e.TagLine === "string" && e.TagLine ? `${e.GameName}#${e.TagLine}` : e.GameName;
  }
  return out;
}

/** E12: RR changes for the session's own account (Riot only returns your own). */
export async function fetchRrUpdates(http: Http, session: Session, clientVersion: string, count = 5): Promise<RrUpdate[]> {
  const body = await get(http, competitiveUpdatesUrl(session, session.puuid, count), session, clientVersion, "E12 competitive updates");
  const matches = Array.isArray(body.Matches) ? body.Matches : [];
  return matches.flatMap((m: Record<string, unknown>): RrUpdate[] => {
    if (typeof m?.MatchID !== "string" || typeof m.RankedRatingEarned !== "number") return [];
    return [
      {
        matchId: m.MatchID,
        earned: m.RankedRatingEarned,
        after: typeof m.RankedRatingAfterUpdate === "number" ? m.RankedRatingAfterUpdate : 0,
        tierAfter: typeof m.TierAfterUpdate === "number" ? m.TierAfterUpdate : 0,
        tierBefore: typeof m.TierBeforeUpdate === "number" ? m.TierBeforeUpdate : 0,
      },
    ];
  });
}

/** GET with the game headers; Riot's error answers become the same typed errors as the shop's. */
async function get(http: Http, url: string, session: Session, clientVersion: string, what: string): Promise<Record<string, unknown>> {
  const res = await http.request(url, { headers: gameHeaders(session, clientVersion), timeoutMs: 20_000 });
  if (res.status === 429) throw new RateLimitedError(what, parseRetryAfter(res.headers.get("retry-after")));
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // handled below
  }
  const errorCode = typeof body?.errorCode === "string" ? body.errorCode : null;
  // 401 and BAD_CLAIMS: the cached session is stale; the caller drops it and retries once (spec).
  if (res.status === 401 || errorCode === "BAD_CLAIMS") throw new BadClaimsError(`${what}: ${errorCode ?? "401"}`);
  if (errorCode === "SCHEDULED_DOWNTIME") throw new MaintenanceError(`${what}: SCHEDULED_DOWNTIME (maintenance)`);
  if (res.status === 404) throw new MatchNotReadyError(`${what}: 404${errorCode ? ` ${errorCode}` : ""}`);
  if (res.status !== 200 || !body) throw new UnexpectedResponseError(`${what} returned ${res.status}${errorCode ? ` ${errorCode}` : ""}`);
  return body;
}
