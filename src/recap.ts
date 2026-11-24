// Match recap, pure part (Match Recap Spec: Riot pd endpoints & stat formulas).
//
// E11 (match details) -> MatchRecap: every player's K/D/A, ACS, HS% and ADR, and each team's result.
// Field names confirmed by spike S2 on 2026-11-25. Names (map, agent, rank) are resolved later from
// valorant-api.com; this module keeps Riot's IDs. Nothing here does I/O.

export interface RecapPlayer {
  puuid: string;
  /** "gameName#tagLine" as of this match; players rename, so it is re-read every match. */
  riotName: string | null;
  teamId: string;
  partyId: string | null;
  agentId: string;
  /** competitiveTier: 0 when unranked. */
  tier: number;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  /** Average combat score: score / rounds, rounded. Null when Riot sent no stats. */
  acs: number | null;
  /** Headshot %: head / (head + body + leg) over every damage entry, rounded; null without shots. */
  hsPercent: number | null;
  /** Average damage per round, rounded. */
  adr: number | null;
}

export interface RecapTeam {
  teamId: string;
  won: boolean;
  roundsWon: number;
}

export interface MatchRecap {
  matchId: string;
  mapId: string;
  queue: string;
  startedAt: string;
  lengthMinutes: number;
  /** False while Riot is still processing: retried on the next poll, never posted (spec). */
  completed: boolean;
  rounds: number;
  teams: RecapTeam[];
  players: RecapPlayer[];
}

export type TeamResult =
  | { kind: "victory" | "defeat" | "draw"; teamId: string; score: string }
  /** Tracked players on both teams. */
  | { kind: "split"; score: string };

/** E11 -> MatchRecap. Returns null if the body isn't a match (no matchInfo or players). */
export function recapFromMatchDetails(body: unknown): MatchRecap | null {
  const info = obj(field(body, "matchInfo"));
  const rawPlayers = arr(field(body, "players"));
  const matchId = str(info?.matchId);
  if (!info || !matchId || rawPlayers.length === 0) return null;

  const roundResults = arr(field(body, "roundResults"));
  // Per player: shots and damage over every round's damage entries.
  const shots = new Map<string, { head: number; body: number; leg: number; damage: number }>();
  for (const round of roundResults) {
    for (const ps of arr(field(round, "playerStats"))) {
      const subject = str(field(ps, "subject"));
      if (!subject) continue;
      const total = shots.get(subject) ?? { head: 0, body: 0, leg: 0, damage: 0 };
      for (const d of arr(field(ps, "damage"))) {
        total.head += num(field(d, "headshots"));
        total.body += num(field(d, "bodyshots"));
        total.leg += num(field(d, "legshots"));
        total.damage += num(field(d, "damage"));
      }
      shots.set(subject, total);
    }
  }

  const players: RecapPlayer[] = [];
  for (const p of rawPlayers) {
    const puuid = str(field(p, "subject"));
    if (!puuid) continue;
    const stats = obj(field(p, "stats"));
    // roundsPlayed per player; the match's round count when Riot sent no stats.
    const rounds = (stats ? num(stats.roundsPlayed) : 0) || roundResults.length || 1;
    const s = shots.get(puuid);
    const hits = s ? s.head + s.body + s.leg : 0;
    const name = str(field(p, "gameName"));
    const tag = str(field(p, "tagLine"));
    players.push({
      puuid,
      riotName: name ? (tag ? `${name}#${tag}` : name) : null,
      teamId: str(field(p, "teamId")) ?? "",
      partyId: str(field(p, "partyId")),
      agentId: (str(field(p, "characterId")) ?? "").toLowerCase(),
      tier: num(field(p, "competitiveTier")),
      kills: stats ? num(stats.kills) : null,
      deaths: stats ? num(stats.deaths) : null,
      assists: stats ? num(stats.assists) : null,
      acs: stats ? Math.round(num(stats.score) / rounds) : null,
      hsPercent: s && hits > 0 ? Math.round((100 * s.head) / hits) : null,
      adr: s ? Math.round(s.damage / rounds) : null,
    });
  }

  const teams = arr(field(body, "teams")).flatMap((t): RecapTeam[] => {
    const teamId = str(field(t, "teamId"));
    return teamId ? [{ teamId, won: field(t, "won") === true, roundsWon: num(field(t, "roundsWon")) }] : [];
  });

  return {
    matchId,
    mapId: str(info.mapId) ?? "",
    // S2: the key is "queueID"; accept "queueId" too in case Riot normalises it.
    queue: str(info.queueID) ?? str(info.queueId) ?? "",
    startedAt: new Date(num(info.gameStartMillis)).toISOString(),
    lengthMinutes: Math.round(num(info.gameLengthMillis) / 60_000),
    completed: info.isCompleted === true,
    rounds: roundResults.length,
    teams,
    players,
  };
}

/**
 * The result for the tracked players' team: "13–9" is their rounds first. Tracked players on both
 * teams make it a "split" (spec: Recap message). Neither team winning is a draw.
 */
export function teamResult(recap: MatchRecap, trackedPuuids: string[]): TeamResult | null {
  const tracked = recap.players.filter((p) => trackedPuuids.includes(p.puuid));
  const teamIds = [...new Set(tracked.map((p) => p.teamId))];
  if (teamIds.length === 0) return null;
  if (teamIds.length > 1) {
    const [a, b] = recap.teams;
    return { kind: "split", score: a && b ? `${a.roundsWon}–${b.roundsWon}` : "" };
  }
  const teamId = teamIds[0] as string;
  const mine = recap.teams.find((t) => t.teamId === teamId);
  const theirs = recap.teams.find((t) => t.teamId !== teamId);
  const score = `${mine?.roundsWon ?? 0}–${theirs?.roundsWon ?? 0}`;
  const kind = mine?.won ? "victory" : theirs?.won ? "defeat" : "draw";
  return { kind, teamId, score };
}

/** Players of one team, highest ACS first (players without stats last). */
export function teamByAcs(recap: MatchRecap, teamId: string): RecapPlayer[] {
  return recap.players.filter((p) => p.teamId === teamId).sort((a, b) => (b.acs ?? -1) - (a.acs ?? -1));
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
