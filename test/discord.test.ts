import { describe, expect, test } from "bun:test";
import { alertMessage, cookieDeadText, inviteUrl, shopMessage, wishlistMessage } from "../src/notify/discord.ts";
import type { ShopSnapshot } from "../src/shop.ts";

const OWNER = "123456789012345678";

const snapshot: ShopSnapshot = {
  fetchedAt: "2026-11-23T03:37:30.000Z",
  expiresAt: "2026-11-24T00:00:00.000Z",
  hash: "h",
  offers: [
    { levelUuid: "a", name: "Imperium Vandal", iconUrl: "https://media.example/vandal.png", vp: 2175, tier: { name: "Exclusive", color: "f5955b" } },
    { levelUuid: "b", name: "b", iconUrl: null, vp: null, tier: null },
  ],
};

describe("shopMessage", () => {
  const message = shopMessage(snapshot);

  test("the text is a Discord countdown to the reset", () => {
    expect(message.content).toBe(`**Daily shop** · resets <t:${Date.parse("2026-11-24T00:00:00Z") / 1000}:R>`);
  });

  test("one embed per skin: name, price, image, tier colour and name", () => {
    expect(message.embeds).toHaveLength(2);
    expect(message.embeds[0]).toEqual({
      title: "Imperium Vandal",
      description: "**2,175 VP**",
      image: { url: "https://media.example/vandal.png" },
      color: 0xf5955b,
      footer: { text: "Exclusive" },
    });
  });

  test("an unknown item has no image, colour or footer", () => {
    expect(message.embeds[1]).toEqual({ title: "b", description: "Price unknown" });
  });

  test("the shop never pings anyone", () => {
    expect(message.allowedMentions).toEqual({ parse: [] });
  });
});

test("a wishlist hit pings only the owner", () => {
  const message = wishlistMessage(snapshot.offers.slice(0, 1), OWNER);
  expect(message.content).toBe(`<@${OWNER}> Wishlist hit: **Imperium Vandal** (2,175 VP) is in your shop today.`);
  expect(message.allowedMentions).toEqual({ users: [OWNER] });
});

test("alerts ping only the owner", () => {
  expect(alertMessage("cookie dead", OWNER)).toEqual({ content: `<@${OWNER}> cookie dead`, embeds: [], allowedMentions: { users: [OWNER] } });
});

test("the invite link asks for bot + slash commands with View Channel, Send Messages and Embed Links", () => {
  // 1024 + 2048 + 16384
  expect(inviteUrl("111", "222")).toBe(
    "https://discord.com/oauth2/authorize?client_id=111&scope=bot%20applications.commands&permissions=19456&guild_id=222",
  );
});

test("the cookie-dead steps name the cookie file and the reauth link", () => {
  const text = cookieDeadText("/app/config/riot-cookie");
  expect(text).toContain("/app/config/riot-cookie");
  expect(text).toContain("<https://auth.riotgames.com/authorize?");
  expect(text.length).toBeLessThan(2000); // Discord's message limit
});
