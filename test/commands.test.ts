import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { handleShopCommand, type ShopCommandDeps, type ShopInteraction } from "../src/commands.ts";
import { CookieDeadError, UnexpectedResponseError } from "../src/riot/auth.ts";
import type { ShopSnapshot } from "../src/shop.ts";

const OWNER = "123456789012345678";
const NOW = Date.parse("2026-11-23T12:00:00Z");

const snapshot = (expiresAt: string, name = "Imperium Vandal"): ShopSnapshot => ({
  fetchedAt: "2026-11-23T03:00:00.000Z",
  expiresAt,
  hash: "h",
  offers: [{ levelUuid: "a", name, iconUrl: null, vp: 2175, tier: null }],
});

function fakeInteraction(userId = OWNER) {
  const events: Array<{ kind: string; options?: any }> = [];
  const interaction: ShopInteraction = {
    user: { id: userId },
    reply: async (options) => events.push({ kind: "reply", options }),
    deferReply: async () => events.push({ kind: "defer" }),
    editReply: async (options) => events.push({ kind: "edit", options }),
  };
  return { interaction, events };
}

function deps(overrides: Partial<ShopCommandDeps> = {}): ShopCommandDeps & { runs: number } {
  const d = {
    runs: 0,
    ownerId: OWNER,
    cookieFile: "config/riot-cookie",
    currentSnapshot: () => null,
    runShop: async () => {
      d.runs++;
      return snapshot("2026-11-24T00:00:00.000Z", "Fresh Skin");
    },
    now: () => NOW,
    ...overrides,
  };
  return d;
}

test("anyone but the owner gets a private refusal and no run", async () => {
  const { interaction, events } = fakeInteraction("999999999999999999");
  const d = deps();
  await handleShopCommand(interaction, d);
  expect(events).toEqual([{ kind: "reply", options: { content: "Sorry, this bot only answers its owner.", flags: MessageFlags.Ephemeral } }]);
  expect(d.runs).toBe(0);
});

test("a snapshot that has not expired is answered at once, without calling Riot", async () => {
  const { interaction, events } = fakeInteraction();
  const d = deps({ currentSnapshot: () => snapshot("2026-11-24T00:00:00.000Z") });
  await handleShopCommand(interaction, d);
  expect(d.runs).toBe(0);
  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe("reply");
  expect(events[0]?.options.embeds[0].title).toBe("Imperium Vandal");
});

test("an expired snapshot starts a run, deferring first", async () => {
  const { interaction, events } = fakeInteraction();
  const d = deps({ currentSnapshot: () => snapshot("2026-11-23T00:00:00.000Z") });
  await handleShopCommand(interaction, d);
  expect(d.runs).toBe(1);
  expect(events.map((e) => e.kind)).toEqual(["defer", "edit"]);
  expect(events[1]?.options.embeds[0].title).toBe("Fresh Skin");
});

test("a dead cookie answers with the steps to replace it", async () => {
  const { interaction, events } = fakeInteraction();
  await handleShopCommand(
    interaction,
    deps({
      runShop: async () => {
        throw new CookieDeadError("login redirect");
      },
    }),
  );
  expect(events[1]?.options.content).toContain("Riot cookie expired");
  expect(events[1]?.options.content).toContain("config/riot-cookie");
});

test("other failures answer with the reason, redacted", async () => {
  const { interaction, events } = fakeInteraction();
  await handleShopCommand(
    interaction,
    deps({
      runShop: async () => {
        throw new UnexpectedResponseError("E6 storefront returned 500 eyJhbGciOiJIUzI1NiJ9.e30.sig");
      },
    }),
  );
  expect(events[1]?.options.content).toBe("Couldn't fetch the shop: E6 storefront returned 500 [jwt]");
});
