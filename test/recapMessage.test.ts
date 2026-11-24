import { expect, test } from "bun:test";
import type { CatalogNames } from "../src/catalog.ts";
import { COLOR, queueName, recapMessage } from "../src/notify/recapMessage.ts";
import type { MatchRecap, RecapPlayer } from "../src/recap.ts";

const JETT = "add6443a-41bd-e414-f6ad-e58d267f4e95";
const SOVA = "320b2a48-4d9b-a075-30f1-1f93a9b638fa";
const names: CatalogNames = {
  maps: { "/Game/Maps/Ascent/Ascent": "Ascent" },
  agents: { [JETT]: "Jett", [SOVA]: "Sova" },
  ranks: { "13": "Gold 2" },
};

const player = (puuid: string, riotName: string, teamId: string, acs: number | null, agentId = JETT): RecapPlayer => ({
  puuid,
  riotName,
  teamId,
  partyId: null,
  agentId,
  tier: 13,
  kills: acs === null ? null : 20,
  deaths: acs === null ? null : 14,
  assists: acs === null ? null : 5,
  acs,
  hsPercent: acs === null ? null : 24,
  adr: acs === null ? null : 162,
});

function recap(): MatchRecap {
  return {
    matchId: "0fb7d8d3-1111-2222-3333-444444444444",
    mapId: "/Game/Maps/Ascent/Ascent",
    queue: "competitive",
    startedAt: "2026-11-24T15:00:00.000Z",
    lengthMinutes: 38,
    completed: true,
    rounds: 22,
    teams: [
      { teamId: "Red", won: false, roundsWon: 9 },
      { teamId: "Blue", won: true, roundsWon: 13 },
    ],
    players: [
      player("p-tyler", "Tyler#0001", "Blue", 268),
      player("p-friend", "friend1#0002", "Blue", 201, SOVA),
      player("p-rando", "a very long player name#1", "Blue", 150),
      player("p-enemy", "abc`x#3", "Red", 240),
      player("p-ghost", "ghost#4", "Red", null),
    ],
  };
}

test("title: result and score for the tracked team, map, queue, length; green on a win", () => {
  const embed = recapMessage({ recap: recap(), tracked: ["p-tyler"], rr: {}, names }).embeds[0]!;
  expect(embed.title).toBe("Victory 13–9 · Ascent · Competitive · 38 min");
  expect(embed.color).toBe(COLOR.win);
});

test("a loss is red; tracked players on both teams is a grey split", () => {
  expect(recapMessage({ recap: recap(), tracked: ["p-enemy"], rr: {}, names }).embeds[0]).toMatchObject({ title: "Defeat 9–13 · Ascent · Competitive · 38 min", color: COLOR.loss });
  const split = recapMessage({ recap: recap(), tracked: ["p-tyler", "p-enemy"], rr: {}, names }).embeds[0]!;
  expect(split.title).toStartWith("Split 9–13");
  expect(split.color).toBe(COLOR.neutral);
  expect(split.fields?.map((f) => f.name)).toEqual(["Team Red", "Team Blue"]);
});

test("one line per tracked player, highest ACS first, with RR once known and … while pending", () => {
  const message = recapMessage({
    recap: recap(),
    tracked: ["p-friend", "p-tyler"],
    rr: { "p-tyler": { matchId: "m", earned: 21, after: 45, tierAfter: 13, tierBefore: 13 }, "p-friend": "pending" },
    names,
  });
  expect(message.embeds[0]?.description).toBe(
    "**Tyler**  Jett  20/14/5  ACS 268  HS 24%  ADR 162  +21 RR → Gold 2 (45)\n**friend1**  Sova  20/14/5  ACS 201  HS 24%  ADR 162  RR …",
  );
  expect(message.allowedMentions).toEqual({ users: [] });
});

test("RR given up on, or a lost one, shows correctly", () => {
  const d = recapMessage({ recap: recap(), tracked: ["p-tyler"], rr: { "p-tyler": "none" }, names }).embeds[0]?.description;
  expect(d).not.toContain("RR");
  const lost = recapMessage({ recap: recap(), tracked: ["p-tyler"], rr: { "p-tyler": { matchId: "m", earned: -18, after: 3, tierAfter: 13, tierBefore: 14 } }, names });
  expect(lost.embeds[0]?.description).toContain("-18 RR → Gold 2 (3)");
});

test("scoreboards: your team first, sorted by ACS, tracked marked, names cut to 12 and backticks removed", () => {
  const fields = recapMessage({ recap: recap(), tracked: ["p-tyler"], rr: {}, names }).embeds[0]!.fields!;
  expect(fields.map((f) => f.name)).toEqual(["Your team", "Enemy team"]);
  expect(fields[0]?.value).toBe(
    ["```", "▶ Jett      Tyler        20/14/5  268", "  Sova      friend1      20/14/5  201", "  Jett      a very long  20/14/5  150", "```"].join("\n"),
  );
  expect(fields[1]?.value).toContain("  Jett      abc'x        20/14/5  240");
  expect(fields[1]?.value).toContain("ghost        —          —");
  for (const f of fields) expect(f.value.length).toBeLessThan(1024);
});

test("footer: the short match ID, and 'late' for sweep finds; unknown names fall back to IDs", () => {
  const late = recapMessage({ recap: recap(), tracked: ["p-tyler"], rr: {}, names, late: true }).embeds[0]!;
  expect(late.footer?.text).toBe("Match 0fb7d8d3 · late");
  const raw = recapMessage({ recap: recap(), tracked: ["p-tyler"], rr: {}, names: null }).embeds[0]!;
  expect(raw.title).toBe("Victory 13–9 · /Game/Maps/Ascent/Ascent · Competitive · 38 min");
  expect(raw.description).toContain("add6443a");
});

test("HenrikDev's map name is used when there is one; queue names", () => {
  const r = { ...recap(), mapId: "7eaecc1b-4337-bbf6-6ab9-04b8f06b3319", mapName: "Ascent" };
  expect(recapMessage({ recap: r, tracked: ["p-tyler"], rr: {}, names: null }).embeds[0]?.title).toContain("· Ascent ·");
  expect(queueName("swiftplay")).toBe("Swiftplay");
  expect(queueName("ggteam")).toBe("Escalation");
  expect(queueName("newqueue")).toBe("Newqueue");
  expect(queueName("")).toBe("Custom");
});

test("tracked players mapped to Discord users are mentioned on their line and pinged in the text; nobody else", () => {
  const message = recapMessage({
    recap: recap(),
    tracked: ["p-tyler", "p-friend"],
    rr: {},
    names,
    discordIds: { "p-tyler": "100000000000000001", "p-friend": "200000000000000002", "p-rando": "999999999999999999" },
  });
  expect(message.content).toBe("<@100000000000000001> <@200000000000000002>");
  expect(message.allowedMentions).toEqual({ users: ["100000000000000001", "200000000000000002"] });
  expect(message.embeds[0]?.description).toStartWith("<@100000000000000001> · **Tyler**  Jett");
  expect(message.embeds[0]?.description).toContain("<@200000000000000002> · **friend1**  Sova");
});

test("without a mapping, nobody is pinged", () => {
  const message = recapMessage({ recap: recap(), tracked: ["p-tyler"], rr: {}, names });
  expect(message.content).toBe("");
  expect(message.allowedMentions).toEqual({ users: [] });
});
