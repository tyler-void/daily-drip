// Match recap spikes (daily-drip — Match Recap Spec, Spikes & acceptance). Read-only.
//
//   bun scripts/recap-spike.ts pd     S2 + S4, with the owner's session. Run on the server with the
//                                     bot stopped until "SESSION READY": signing in rotates the
//                                     owner's cookie, and the rotated jar is saved to state.json
//                                     exactly as the bot would. The rest only uses the in-memory
//                                     tokens, so the bot can run again meanwhile.
//
// S2: E10 (history), E11 (details) and E12 (competitive updates) for the owner's newest match; the
//     recap fields with the spec's formulas, and the field names the spec only inferred.
//     FRIEND_PUUID (optional, a consenting friend's): is E10 for someone else's PUUID allowed? Only
//     the status and the number of matches are printed, never their matches.
// S4: the same session's E10 at about 0, 30, 55 and 65 min: when does it stop working? E1 runs once.
//
// Privacy: the owner's own stats are printed; the other nine players appear only as agent and
// numbers, never names. No token, cookie or ID token is printed (everything goes through redact).

import { fetchGameVersion } from "../src/catalog.ts";
import { createHttp } from "../src/http.ts";
import { addSecret, redact } from "../src/log.ts";
import { authenticate, type Session } from "../src/riot/auth.ts";
import { gameHeaders } from "../src/riot/store.ts";
import { loadState, saveState } from "../src/state.ts";

const STATE_FILE = process.env.STATE_FILE ?? "data/state.json";
const COOKIE_FILE = process.env.RIOT_COOKIE_FILE ?? "config/riot-cookie";
const FRIEND_PUUID = process.env.FRIEND_PUUID ?? "";
const CHECKS_MIN = (process.env.S4_MINUTES ?? "30,55,65").split(",").map(Number).filter((n) => n > 0);

const http = createHttp();
const say = (label: string, value: unknown = "") => console.log(redact(`${label.padEnd(30)} ${typeof value === "string" ? value : JSON.stringify(value)}`));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (id: string) => id.slice(0, 8);

type Json = Record<string, any>;
async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: Json | null }> {
  const res = await http.request(url, { headers, timeoutMs: 30_000 });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: null };
  }
}

const mode = process.argv[2];
if (mode !== "pd") {
  console.log("usage: bun scripts/recap-spike.ts pd");
  process.exit(1);
}

// ---------- sign in once (E1-E4), saving the rotated cookie jar like the bot ----------

const state = await loadState(STATE_FILE);
let session: Session;
try {
  session = await authenticate({ http, state, save: (s) => saveState(s, STATE_FILE), cookieFile: COOKIE_FILE });
} catch (err) {
  console.log(redact(`SESSION FAILED: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(2);
}
for (const v of [session.accessToken, session.idToken, session.entitlementsToken]) addSecret(v);
const signedInAt = Date.now();
console.log("SESSION READY (E1 ran once; the bot can be started again)");
say("shard", session.shard);

const version = await fetchGameVersion(http);
const headers = gameHeaders(session, version.riotClientVersion);
const pd = `https://pd.${session.shard}.a.pvp.net`;

// ---------- S2: E10, E11, E12 for the owner's newest match ----------

const e10 = await getJson(`${pd}/match-history/v1/history/${session.puuid}?startIndex=0&endIndex=5`, headers);
const history: Json[] = e10.body?.History ?? [];
say("E10 history", `${e10.status}, ${history.length} matches; keys: ${Object.keys(history[0] ?? {}).join(",")}`);
for (const h of history) say("  match", `${short(String(h.MatchID))} queue=${h.QueueID || "(empty)"} start=${new Date(h.GameStartTime).toISOString()}`);

const newest = history[0];
if (newest) {
  const e11 = await getJson(`${pd}/match-details/v1/matches/${newest.MatchID}`, headers);
  const m = e11.body ?? {};
  const info: Json = m.matchInfo ?? {};
  say("E11 details", `${e11.status}; top-level keys: ${Object.keys(m).join(",")}`);
  say("  matchInfo keys", Object.keys(info).join(","));
  say("  map / queue / completed", `${info.mapId} / ${info.queueID ?? info.queueId} / ${info.isCompleted}`);
  say("  length", `${Math.round((info.gameLengthMillis ?? 0) / 60000)} min`);
  const teams: Json[] = m.teams ?? [];
  say("  teams[0] keys", Object.keys(teams[0] ?? {}).join(","));
  for (const t of teams) say("  team", `${t.teamId} won=${t.won} roundsWon=${t.roundsWon} roundsPlayed=${t.roundsPlayed}`);
  const players: Json[] = m.players ?? [];
  say("  players", `${players.length}; player keys: ${Object.keys(players[0] ?? {}).join(",")}`);
  say("  stats keys", Object.keys(players.find((p) => p.stats)?.stats ?? {}).join(","));
  const rounds: Json[] = m.roundResults ?? [];
  say("  roundResults", `${rounds.length}; playerStats keys: ${Object.keys(rounds[0]?.playerStats?.[0] ?? {}).join(",")}`);
  say("  damage[] keys", Object.keys(rounds.flatMap((r) => r.playerStats ?? []).find((ps: Json) => ps.damage?.length)?.damage?.[0] ?? {}).join(","));

  // Names from valorant-api.com, to check the mapping the spec only inferred.
  const fetchList = async (path: string): Promise<Json[]> => ((await getJson(`https://valorant-api.com/v1/${path}`, {})).body?.data ?? []) as Json[];
  const [maps, agents, tiers] = await Promise.all([fetchList("maps"), fetchList("agents?isPlayableCharacter=true"), fetchList("competitivetiers")]);
  const mapName = maps.find((x) => x.mapUrl === info.mapId)?.displayName ?? `? (${info.mapId})`;
  const agentName = (id: string) => agents.find((a) => a.uuid?.toLowerCase() === String(id).toLowerCase())?.displayName ?? `?${short(String(id))}`;
  const tierTable: Json[] = (tiers.at(-1)?.tiers ?? []) as Json[];
  const tierName = (n: number) => tierTable.find((t) => t.tier === n)?.tierName ?? `tier ${n}`;
  say("  map name", mapName);

  // The spec's formulas.
  const statsOf = (p: Json) => {
    const R = p.stats?.roundsPlayed || rounds.length || 1;
    let head = 0;
    let body = 0;
    let leg = 0;
    let dealt = 0;
    for (const r of rounds)
      for (const ps of r.playerStats ?? [])
        if (ps.subject === p.subject)
          for (const d of ps.damage ?? []) {
            head += d.headshots ?? 0;
            body += d.bodyshots ?? 0;
            leg += d.legshots ?? 0;
            dealt += d.damage ?? 0;
          }
    const shots = head + body + leg;
    return {
      kda: p.stats ? `${p.stats.kills}/${p.stats.deaths}/${p.stats.assists}` : "—",
      acs: p.stats ? Math.round(p.stats.score / R) : null,
      hs: shots ? Math.round((100 * head) / shots) : null,
      adr: Math.round(dealt / R),
    };
  };

  const me = players.find((p) => p.subject === session.puuid);
  if (me) {
    const s = statsOf(me);
    const myTeam = teams.find((t) => t.teamId === me.teamId);
    const other = teams.find((t) => t.teamId !== me.teamId);
    const result = myTeam ? (myTeam.won ? "Victory" : other?.won ? "Defeat" : "Draw") : "?";
    say("OWNER (check against the game)", `${result} ${myTeam?.roundsWon}–${other?.roundsWon} · ${mapName} · ${agentName(me.characterId)} ${s.kda} ACS ${s.acs} HS ${s.hs}% ADR ${s.adr} · ${tierName(me.competitiveTier)}`);
    for (const team of teams) {
      const rows = players
        .filter((p) => p.teamId === team.teamId)
        .map((p) => ({ p, s: statsOf(p) }))
        .sort((a, b) => (b.s.acs ?? 0) - (a.s.acs ?? 0));
      for (const { p, s } of rows) say(`  ${team.teamId}${p.subject === session.puuid ? " ▶ owner" : ""}`, `${agentName(p.characterId)} ${s.kda} ACS ${s.acs} HS ${s.hs}% ADR ${s.adr}`);
    }
  } else {
    say("OWNER", "not found in players[] (unexpected)");
  }

  const queue = String(info.queueID ?? info.queueId ?? "");
  const e12 = await getJson(`${pd}/mmr/v1/players/${session.puuid}/competitiveupdates?startIndex=0&endIndex=5&queue=competitive`, headers);
  const updates: Json[] = e12.body?.Matches ?? [];
  say("E12 competitive updates", `${e12.status}, ${updates.length} entries; keys: ${Object.keys(updates[0] ?? {}).join(",")}`);
  const rr = updates.find((u) => u.MatchID === newest.MatchID);
  say("  RR for this match", rr ? `${rr.RankedRatingEarned >= 0 ? "+" : ""}${rr.RankedRatingEarned} → ${tierName(rr.TierAfterUpdate)} (${rr.RankedRatingAfterUpdate})` : `none (queue ${queue || "?"}; only competitive has RR)`);
}

if (FRIEND_PUUID) {
  const f = await getJson(`${pd}/match-history/v1/history/${FRIEND_PUUID}?startIndex=0&endIndex=5`, headers);
  say("S2 E10 for another PUUID", `${f.status}, ${(f.body?.History ?? []).length} matches${f.body?.errorCode ? `, ${f.body.errorCode}` : ""}`);
} else {
  say("S2 E10 for another PUUID", "skipped (no FRIEND_PUUID)");
}

// ---------- S4: the same session over time ----------

say("S4 at 0 min", `E10 ${e10.status}`);
for (const minute of CHECKS_MIN) {
  await sleep(Math.max(0, signedInAt + minute * 60_000 - Date.now()));
  const r = await getJson(`${pd}/match-history/v1/history/${session.puuid}?startIndex=0&endIndex=1`, headers);
  say(`S4 at ${minute} min`, `E10 ${r.status}${r.body?.errorCode ? ` ${r.body.errorCode}` : ""}`);
}
console.log("SPIKE DONE (E1 ran once in this process)");
