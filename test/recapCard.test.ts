import { expect, test } from "bun:test";
import type { CatalogNames } from "../src/catalog.ts";
import { cardTree, loadArt, renderRecapCard } from "../src/notify/recapCard.ts";
import type { MatchRecap, RecapPlayer } from "../src/recap.ts";

const JETT = "add6443a-41bd-e414-f6ad-e58d267f4e95";
const names: CatalogNames = {
  maps: { "/Game/Maps/Ascent/Ascent": "Ascent" },
  agents: { [JETT]: "Jett" },
  ranks: { "13": "Gold 2" },
  agentIcons: { [JETT]: "https://example.test/jett.png" },
  mapArt: { "/Game/Maps/Ascent/Ascent": "https://example.test/ascent.png" },
};
const player = (puuid: string, teamId: string, acs: number): RecapPlayer => ({
  puuid, riotName: null, teamId, partyId: null, agentId: JETT, tier: 13, kills: 20, deaths: 14, assists: 5, acs, hsPercent: 24, adr: 162,
});
const recap: MatchRecap = {
  matchId: "0fb7d8d3-1111-2222-3333-444444444444", mapId: "/Game/Maps/Ascent/Ascent", queue: "competitive",
  startedAt: "2026-11-24T15:00:00.000Z", lengthMinutes: 38, completed: true, rounds: 22,
  teams: [{ teamId: "Blue", won: true, roundsWon: 13 }, { teamId: "Red", won: false, roundsWon: 9 }],
  players: [player("me", "Blue", 268), player("b2", "Blue", 150), player("r1", "Red", 302), player("r2", "Red", 140)],
};
const text = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const kids = (node as { props?: { children?: unknown } }).props?.children;
  return Array.isArray(kids) ? kids.map(text).join(" ") : text(kids);
};

test("the card shows the result, map, tracked player by their Riot name, both boards; never an ID fragment", () => {
  const all = text(cardTree({ recap, tracked: ["me"], rr: { me: { matchId: recap.matchId, earned: 21, after: 45, tierAfter: 13, tierBefore: 13 } }, names, riotNames: { me: "Tyler#0001" } }));
  for (const want of ["VICTORY", "13–9", "Ascent", "Tyler", "#0001", "+21 RR", "Gold 2 · 45", "Your team", "Enemy team"]) expect(all).toContain(want);
  expect(all).not.toContain("b2");
});

test("art that can't be fetched is left out, not fatal", async () => {
  const fail = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
  expect(await loadArt(recap, names, fail)).toEqual({ map: null, agents: {} });
});

test("renders a PNG", async () => {
  const { png, svg } = await renderRecapCard({ recap, tracked: ["me"], rr: {}, names });
  expect([...png.slice(0, 4)]).toEqual([137, 80, 78, 71]);
  expect(svg).toContain("dd-grain");
}, 60_000);
