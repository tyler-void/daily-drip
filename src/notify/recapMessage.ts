// The recap message (Match Recap Spec: Recap message). One embed per match:
//
//   @Tyler @friend1      the text pings every roster member who played, and only them
//   Victory 13–9 · Ascent · Competitive · 38 min            green; red on a loss, grey on a draw or split
//   @Tyler · Tyler  Jett  21/14/5  ACS 268  HS 24%  ADR 162  +21 RR → Gold 2 (45)
//   ...one line per tracked player, highest ACS first
//   Your team / Enemy team: a code block each, sorted by ACS, tracked players marked ▶
//
// Posted as soon as the stats are in, then edited once when a late RR change arrives; Discord doesn't
// notify on edits, so nobody is pinged twice. Roster members put themselves on the roster (Match
// Recap Spec: Roster & consent). Pure: the caller resolves names through the catalog.

import { type APIEmbed, escapeMarkdown } from "discord.js";
import type { CatalogNames } from "../catalog.ts";
import type { MatchRecap, RecapPlayer } from "../recap.ts";
import { teamByAcs, teamResult } from "../recap.ts";
import type { RrUpdate } from "../riot/matches.ts";
import type { DiscordMessage } from "./discord.ts";

/** A tracked player's RR: known, still on its way, or given up on (after 15 min, the spec drops it). */
export type RrState = RrUpdate | "pending" | "none";

export interface RecapInput {
  recap: MatchRecap;
  /** PUUIDs of roster members in this match. */
  tracked: string[];
  /** By PUUID; only competitive matches have RR. */
  rr: Record<string, RrState>;
  names: CatalogNames | null;
  /** Found by the daily sweep, not by a live poll. */
  late?: boolean;
  /** PUUID -> Discord user ID of each tracked player: their mention, and who gets pinged. */
  discordIds?: Record<string, string>;
}

export const COLOR = { win: 0x3ba55d, loss: 0xed4245, neutral: 0x99aab5 } as const;
const NAME_WIDTH = 12;
const AGENT_WIDTH = 9;

const QUEUES: Record<string, string> = {
  competitive: "Competitive",
  unrated: "Unrated",
  swiftplay: "Swiftplay",
  spikerush: "Spike Rush",
  premier: "Premier",
  deathmatch: "Deathmatch",
  ggteam: "Escalation",
  hurm: "Team Deathmatch",
  newmap: "New Map",
};

export function queueName(queue: string): string {
  return QUEUES[queue] ?? (queue ? queue.charAt(0).toUpperCase() + queue.slice(1) : "Custom");
}

export function recapMessage(input: RecapInput): DiscordMessage {
  const { recap, tracked, names } = input;
  const result = teamResult(recap, tracked);
  const map = recap.mapName ?? names?.maps[recap.mapId] ?? names?.maps[recap.mapId.toLowerCase()] ?? recap.mapId;
  const headline = !result
    ? "Match"
    : result.kind === "split"
      ? `Split ${result.score}`
      : `${result.kind === "victory" ? "Victory" : result.kind === "defeat" ? "Defeat" : "Draw"} ${result.score}`;
  const color = result?.kind === "victory" ? COLOR.win : result?.kind === "defeat" ? COLOR.loss : COLOR.neutral;

  const agent = (p: RecapPlayer) => names?.agents[p.agentId] ?? (p.agentId ? p.agentId.slice(0, 8) : "?");
  const rank = (tier: number) => names?.ranks[String(tier)] ?? `tier ${tier}`;
  const gameName = (p: RecapPlayer) => (p.riotName ?? p.puuid.slice(0, 8)).split("#")[0] as string;

  // One line per tracked player, highest ACS first.
  const trackedPlayers = recap.players.filter((p) => tracked.includes(p.puuid)).sort((a, b) => (b.acs ?? -1) - (a.acs ?? -1));
  const lines = trackedPlayers.map((p) => {
    const discordId = input.discordIds?.[p.puuid];
    const who = discordId ? `<@${discordId}> · **${escapeMarkdown(gameName(p))}**` : `**${escapeMarkdown(gameName(p))}**`;
    const parts = [who, agent(p), kda(p)];
    if (p.acs !== null) parts.push(`ACS ${p.acs}`);
    if (p.hsPercent !== null) parts.push(`HS ${p.hsPercent}%`);
    if (p.adr !== null) parts.push(`ADR ${p.adr}`);
    const rr = input.rr[p.puuid];
    if (rr === "pending") parts.push("RR …");
    else if (rr && rr !== "none") parts.push(`${rr.earned >= 0 ? "+" : ""}${rr.earned} RR → ${rank(rr.tierAfter)} (${rr.after})`);
    return parts.join("  ");
  });

  // Teams: the tracked players' team first ("Your team"); a split keeps Riot's order.
  const teamIds = recap.teams.map((t) => t.teamId);
  const ourTeam = result && result.kind !== "split" ? result.teamId : null;
  const ordered = ourTeam ? [ourTeam, ...teamIds.filter((t) => t !== ourTeam)] : teamIds;
  const fields = ordered.slice(0, 2).map((teamId, i) => ({
    name: ourTeam ? (i === 0 ? "Your team" : "Enemy team") : `Team ${teamId}`,
    value: scoreboard(teamByAcs(recap, teamId), tracked, agent, gameName),
    inline: false,
  }));

  const embed: APIEmbed = {
    title: [headline, map, queueName(recap.queue), recap.lengthMinutes ? `${recap.lengthMinutes} min` : ""].filter(Boolean).join(" · "),
    description: lines.join("\n") || undefined,
    color,
    fields,
    footer: { text: `Match ${recap.matchId.slice(0, 8)}${input.late ? " · late" : ""}` },
    timestamp: recap.startedAt,
  };
  // Ping the tracked players who are mapped to a Discord user, and only them.
  const pinged = [...new Set(trackedPlayers.flatMap((p) => (input.discordIds?.[p.puuid] ? [input.discordIds[p.puuid] as string] : [])))];
  return { content: pinged.map((id) => `<@${id}>`).join(" "), embeds: [embed], allowedMentions: { users: pinged } };
}

function kda(p: RecapPlayer): string {
  return p.kills === null ? "—" : `${p.kills}/${p.deaths}/${p.assists}`;
}

/** A code block: marker, agent, name, K/D/A, ACS. Names are cut to 12 and stripped of backticks. */
function scoreboard(players: RecapPlayer[], tracked: string[], agent: (p: RecapPlayer) => string, gameName: (p: RecapPlayer) => string): string {
  const rows = players.map((p) => {
    const marker = tracked.includes(p.puuid) ? "▶" : " ";
    const name = gameName(p).replaceAll("`", "'").slice(0, NAME_WIDTH).padEnd(NAME_WIDTH);
    return `${marker} ${agent(p).slice(0, AGENT_WIDTH).padEnd(AGENT_WIDTH)} ${name} ${kda(p).padEnd(8)} ${(p.acs === null ? "—" : String(p.acs)).padStart(3)}`;
  });
  return `\`\`\`\n${rows.join("\n") || " "}\n\`\`\``;
}
