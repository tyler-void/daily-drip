// Match recap, pure part (Match Recap Spec: Riot pd endpoints & stat formulas; HenrikDev integration).
//
// E11 (Riot match details) or H2 (a HenrikDev v4 match) -> MatchRecap: every player's K/D/A, ACS,
// HS% and ADR, and each team's result, with the same formulas for both. Field names confirmed by
// spikes S2 and S3 on 2026-11-25; both sources gave identical numbers for the same match.
// Names (map, agent, rank) are resolved later from valorant-api.com, except that HenrikDev already
// names the map. Nothing here does I/O.

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
  /** Riot's map path, e.g. "/Game/Maps/Ascent/Ascent" (E11), or valorant-api.com's map UUID (H2). */
  mapId: string;
  /** The map's name when the source gives it (H2); otherwise resolved from mapId. */
  mapName?: string;
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
 * H2 (one entry of HenrikDev's v4 matches `data`) -> MatchRecap. Its per-player totals replace
 * E11's per-round damage entries: ACS = score / rounds, HS% = head / (head + body + leg), ADR =
 * damage dealt / rounds, with rounds = the length of the match's `rounds` array (spec).
 */
export function recapFromHenrikMatch(match: unknown): MatchRecap | null {
  const meta = obj(field(match, "metadata"));
  const matchId = str(meta?.match_id);
  const rawPlayers = arr(field(match, "players"));
  if (!meta || !matchId || rawPlayers.length === 0) return null;
  const rounds = arr(field(match, "rounds")).length;
  const players = rawPlayers.flatMap((p): RecapPlayer[] => {
    const puuid = str(field(p, "puuid"));
    if (!puuid) return [];
    const stats = obj(field(p, "stats"));
    const perRound = rounds || 1;
    const head = num(stats?.headshots);
    const hits = head + num(stats?.bodyshots) + num(stats?.legshots);
    const damage = obj(stats?.damage);
    const name = str(field(p, "name"));
    const tag = str(field(p, "tag"));
    return [
      {
        puuid,
        riotName: name ? (tag ? `${name}#${tag}` : name) : null,
        teamId: str(field(p, "team_id")) ?? "",
        partyId: str(field(p, "party_id")),
        agentId: (str(field(field(p, "agent"), "id")) ?? "").toLowerCase(),
        tier: num(field(field(p, "tier"), "id")),
        kills: stats ? num(stats.kills) : null,
        deaths: stats ? num(stats.deaths) : null,
        assists: stats ? num(stats.assists) : null,
        acs: stats ? Math.round(num(stats.score) / perRound) : null,
        hsPercent: hits > 0 ? Math.round((100 * head) / hits) : null,
        adr: stats ? Math.round(num(damage ? damage.dealt : stats.damage) / perRound) : null,
      },
    ];
  });
  const teams = arr(field(match, "teams")).flatMap((t): RecapTeam[] => {
    const teamId = str(field(t, "team_id"));
    return teamId ? [{ teamId, won: field(t, "won") === true, roundsWon: num(field(field(t, "rounds"), "won")) }] : [];
  });
  const map = obj(meta.map);
  return {
    matchId,
    mapId: str(map?.id) ?? "",
    mapName: str(map?.name) ?? undefined,
    queue: str(obj(meta.queue)?.id) ?? "",
    startedAt: str(meta.started_at) ?? new Date(0).toISOString(),
    lengthMinutes: Math.round(num(meta.game_length_in_ms) / 60_000),
    completed: meta.is_completed === true,
    rounds,
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
