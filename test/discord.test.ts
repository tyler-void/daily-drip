import { describe, expect, test } from "bun:test";
import { cookieDeadText } from "../src/alerts.ts";
import type { Client } from "discord.js";
import { alertMessage, CANNOT_DM, createPersonNotifier, DM_BLOCKED_NOTE, inviteUrl, previewMessage, shopMessage, wishlistMessage } from "../src/notify/discord.ts";
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

describe("shopMessage with a holder", () => {
  const FRIEND = "200000000000000002";

  test("the post after a reset names and pings the person whose shop it is", () => {
    const message = shopMessage(snapshot, { userId: FRIEND, ping: true });
    expect(message.content).toStartWith(`<@${FRIEND}>'s **daily shop** · resets <t:`);
    expect(message.allowedMentions).toEqual({ users: [FRIEND] });
  });

  test("their Riot ID follows the mention, escaped so it can't change the formatting", () => {
    expect(shopMessage(snapshot, { userId: FRIEND, ping: true, riotName: "Friend#0001" }).content).toStartWith(
      `<@${FRIEND}>'s **daily shop** (Friend#0001) · resets <t:`,
    );
    expect(shopMessage(snapshot, { userId: FRIEND, ping: true, riotName: "*bold*_x#0001" }).content).toContain("(\\*bold\\*\\_x#0001)");
  });

  test("a /shop reply names them without a ping", () => {
    expect(shopMessage(snapshot, { userId: FRIEND, ping: false }).allowedMentions).toEqual({ parse: [] });
  });
});

describe("createPersonNotifier", () => {
  const CHANNEL = "300000000000000003";
  const PERSON = "200000000000000002";

  /** A fake client: records every DM and channel message; DMs can be blocked. */
  function fakeClient(dmBlocked = false) {
    const sent: Array<{ to: string; content: string; allowedMentions: unknown }> = [];
    const client = {
      users: {
        fetch: async (id: string) => ({
          send: async (m: any) => {
            if (dmBlocked) throw Object.assign(new Error("Cannot send messages to this user"), { code: CANNOT_DM });
            sent.push({ to: `dm:${id}`, content: m.content, allowedMentions: m.allowedMentions });
          },
        }),
      },
      channels: {
        fetch: async (id: string) => ({
          isSendable: () => true,
          send: async (m: any) => void sent.push({ to: `channel:${id}`, content: m.content, allowedMentions: m.allowedMentions }),
        }),
      },
    } as unknown as Client;
    return { client, sent };
  }

  test("the shop goes in the channel with a ping; a wishlist hit goes by DM, first", async () => {
    const { client, sent } = fakeClient();
    await createPersonNotifier(client, CHANNEL, PERSON, "dm", () => "Friend#0001").sendShop(snapshot, snapshot.offers.slice(0, 1));
    expect(sent.map((m) => m.to)).toEqual([`dm:${PERSON}`, `channel:${CHANNEL}`]);
    expect(sent[1]?.content).toContain("(Friend#0001)");
    expect(sent[0]?.content).toContain("Imperium Vandal");
    expect(sent[1]?.content).toStartWith(`<@${PERSON}>'s **daily shop**`);
    expect(sent[1]?.allowedMentions).toEqual({ users: [PERSON] });
  });

  test("no wishlist hit and no preview videos: only the channel post", async () => {
    const { client, sent } = fakeClient();
    await createPersonNotifier(client, CHANNEL, PERSON, "dm").sendShop(snapshot, []);
    expect(sent.map((m) => m.to)).toEqual([`channel:${CHANNEL}`]);
  });

  test("preview videos follow the shop post as a second channel message", async () => {
    const { client, sent } = fakeClient();
    await createPersonNotifier(client, CHANNEL, PERSON, "dm").sendShop(withVideo, []);
    expect(sent.map((m) => m.to)).toEqual([`channel:${CHANNEL}`, `channel:${CHANNEL}`]);
    expect(sent[1]?.content).toBe("Imperium Vandal (fully upgraded)\nhttps://v.example/imperium-top.mp4");
  });

  test("a failed preview message doesn't fail the post (which would make it be posted again)", async () => {
    const { client, sent } = fakeClient();
    const channels = (client as any).channels;
    let n = 0;
    const original = channels.fetch;
    channels.fetch = async (id: string) => {
      const ch = await original(id);
      return { ...ch, send: async (m: any) => (++n === 2 ? Promise.reject(new Error("Discord 500")) : ch.send(m)) };
    };
    await createPersonNotifier(client, CHANNEL, PERSON, "dm").sendShop(withVideo, []);
    expect(sent).toHaveLength(1);
  });

  test("blocked DMs: one note in the channel that names no skin, and the shop is still posted", async () => {
    const { client, sent } = fakeClient(true);
    const notifier = createPersonNotifier(client, CHANNEL, PERSON, "dm");
    await notifier.sendShop(snapshot, snapshot.offers.slice(0, 1));
    await notifier.sendShop(snapshot, snapshot.offers.slice(0, 1));
    const notes = sent.filter((m) => m.content.includes(DM_BLOCKED_NOTE));
    expect(notes).toHaveLength(1);
    expect(sent.every((m) => !m.content.includes("Wishlist hit"))).toBe(true);
    expect(sent.filter((m) => m.content.includes("daily shop"))).toHaveLength(2);
  });

  test("the owner's alerts go to the channel; a member's go by DM", async () => {
    const owner = fakeClient();
    await createPersonNotifier(owner.client, CHANNEL, OWNER, "channel").sendAlert("cookie dead");
    expect(owner.sent).toEqual([{ to: `channel:${CHANNEL}`, content: `<@${OWNER}> cookie dead`, allowedMentions: { users: [OWNER] } }]);
    const member = fakeClient();
    await createPersonNotifier(member.client, CHANNEL, PERSON, "dm").sendAlert("link again");
    expect(member.sent.map((m) => m.to)).toEqual([`dm:${PERSON}`]);
  });
});

describe("shopMessage links", () => {
  const withLinks: ShopSnapshot = {
    ...snapshot,
    offers: [
      { ...snapshot.offers[0]!, links: { fandom: "https://valorant.fandom.com/wiki/Imperium_Collection", trailer: "https://www.youtube.com/results?search_query=VALORANT+Imperium+skins+trailer", preview: "https://v.example/imperium.mp4" } },
      { ...snapshot.offers[0]!, name: "Celestial Judge", links: { fandom: "https://valorant.fandom.com/wiki/Special:Search?query=Celestial", trailer: "https://www.youtube.com/results?search_query=VALORANT+Celestial+skins+trailer", preview: null } },
      snapshot.offers[1]!,
    ],
  };
  const embeds = shopMessage(withLinks).embeds;

  test("the skin name links to Fandom, and the line under the price has Fandom, Trailer and Preview", () => {
    expect(embeds[0]?.url).toBe("https://valorant.fandom.com/wiki/Imperium_Collection");
    expect(embeds[0]?.description).toBe(
      "**2,175 VP**\n[Fandom](https://valorant.fandom.com/wiki/Imperium_Collection) · [Trailer](https://www.youtube.com/results?search_query=VALORANT+Imperium+skins+trailer) · [Preview](https://v.example/imperium.mp4)",
    );
  });

  test("no preview video: no Preview link", () => {
    expect(embeds[1]?.description).not.toContain("Preview");
    expect(embeds[1]?.description).toContain("[Trailer]");
  });

  test("an unknown item, or a snapshot saved before links, has no links at all", () => {
    expect(embeds[2]).toEqual({ title: "b", description: "Price unknown" });
  });
});

const withVideo: ShopSnapshot = {
  ...snapshot,
  offers: [
    { ...snapshot.offers[0]!, links: { fandom: "https://f.example", trailer: "https://y.example", preview: "https://v.example/imperium-top.mp4" } },
    { ...snapshot.offers[0]!, name: "No *Video*", links: { fandom: "https://f.example", trailer: "https://y.example", preview: null } },
    snapshot.offers[1]!,
  ],
};

test("previewMessage lists only skins with a video, names escaped, and pings no one", () => {
  expect(previewMessage(withVideo)).toEqual({
    content: "Imperium Vandal (fully upgraded)\nhttps://v.example/imperium-top.mp4",
    embeds: [],
    allowedMentions: { parse: [] },
  });
  const escaped = previewMessage({ ...withVideo, offers: [{ ...withVideo.offers[1]!, links: { ...withVideo.offers[1]!.links!, preview: "https://v.example/x.mp4" } }] });
  expect(escaped?.content).toStartWith("No \\*Video\\* (fully upgraded)");
  expect(previewMessage(snapshot)).toBeNull();
});
