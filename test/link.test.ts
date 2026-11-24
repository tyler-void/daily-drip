import { expect, test } from "bun:test";
import { ButtonStyle, MessageFlags } from "discord.js";
import {
  type CommandDeps,
  handleLinkCommand,
  handleLinkModal,
  handlePasteButton,
  handleShopCommand,
  handleUnlinkCommand,
  handleWishlistCommand,
  LINK_ADDRESS_FIELD,
  LINK_MODAL,
  LINK_PASTE_BUTTON,
  LINK_STEPS,
  type MemberCommands,
  pasteModal,
  UNLINKED,
  type UserShop,
  type WishlistInteraction,
} from "../src/commands.ts";
import { linkDeadText } from "../src/members.ts";
import { LoginDeadError } from "../src/riot/login.ts";
import type { ShopSnapshot } from "../src/shop.ts";

const OWNER = "100000000000000001";
const FRIEND = "200000000000000002";
const STRANGER = "999999999999999999";
const NOW = Date.parse("2026-11-24T12:00:00Z");
const LIVE = "2026-11-25T00:00:00.000Z";
const SIGN_IN_URL = "https://auth.riotgames.com/authorize?client_id=riot-client&nonce=n";
const PASTED = "http://localhost/redirect?code=SECRET-ONE-TIME-CODE";

const snapshot = (names: string[], expiresAt = LIVE): ShopSnapshot => ({
  fetchedAt: "",
  expiresAt,
  hash: names.join(),
  offers: names.map((name, i) => ({ levelUuid: `u${i}`, name, iconUrl: null, vp: 1775, tier: null })),
});

type Events = Array<{ kind: string; options?: any }>;

function interaction(userId: string, extra: Record<string, unknown> = {}) {
  const events: Events = [];
  const record = (kind: string) => async (options?: unknown) => void events.push({ kind, options });
  return {
    events,
    interaction: {
      user: { id: userId, username: `user-${userId.slice(0, 3)}` },
      reply: record("reply"),
      deferReply: record("defer"),
      editReply: record("edit"),
      showModal: record("modal"),
      options: { getSubcommand: () => "", getString: () => null },
      fields: { getTextInputValue: (id: string) => (id === LINK_ADDRESS_FIELD ? PASTED : "") },
      ...extra,
    },
  };
}

function memberShop(over: Partial<UserShop> = {}): UserShop & { wishlist: string[] } {
  const shop: UserShop & { wishlist: string[] } = {
    wishlist: [] as string[],
    currentSnapshot: () => snapshot(["Friend Skin"]),
    runShop: async () => snapshot(["Fresh Friend Skin"]),
    getWishlist: () => shop.wishlist,
    setWishlist: async (entries: string[]) => {
      shop.wishlist = entries;
    },
    ...over,
  };
  return shop;
}

function deps(members?: Partial<MemberCommands>, friend: UserShop | null = memberShop()): CommandDeps & { ownerWishlist: string[] } {
  const d = {
    ownerWishlist: [] as string[],
    ownerId: OWNER,
    cookieFile: "config/riot-cookie",
    currentSnapshot: () => snapshot(["Owner Skin"]),
    runShop: async () => snapshot(["Owner Skin"]),
    getWishlist: () => d.ownerWishlist,
    setWishlist: async (entries: string[]) => {
      d.ownerWishlist = entries;
    },
    storeSkins: () => [],
    now: () => NOW,
    members:
      members === undefined
        ? undefined
        : {
            shopFor: (id: string) => (id === FRIEND ? friend : null),
            startLink: () => ({ ok: true as const, value: { url: SIGN_IN_URL } }),
            finishLink: async () => ({ ok: true as const, value: { riotName: "Friend#0001" } }),
            unlink: async () => ({ ok: true as const, value: undefined }),
            ...members,
          },
  };
  return d;
}

test("with linking on, a stranger is told to /link instead of 'owner only'", async () => {
  const { interaction: i, events } = interaction(STRANGER);
  await handleShopCommand(i, deps({}));
  expect(events).toEqual([{ kind: "reply", options: { content: expect.stringContaining("/link"), flags: MessageFlags.Ephemeral } }]);
});

test("a member's /shop is their own shop, answered privately", async () => {
  const { interaction: i, events } = interaction(FRIEND);
  await handleShopCommand(i, deps({}));
  expect(events[0]?.options.embeds[0].title).toBe("Friend Skin");
  expect(events[0]?.options.flags).toBe(MessageFlags.Ephemeral);
});

test("the owner's /shop still goes in the channel", async () => {
  const { interaction: i, events } = interaction(OWNER);
  await handleShopCommand(i, deps({}));
  expect(events[0]?.options.embeds[0].title).toBe("Owner Skin");
  expect(events[0]?.options.flags).toBeUndefined();
});

test("a member whose sign-in died is told to link again", async () => {
  const friend = memberShop({
    currentSnapshot: () => null,
    runShop: async () => {
      throw new LoginDeadError("invalid_grant");
    },
  });
  const { interaction: i, events } = interaction(FRIEND);
  await handleShopCommand(i, deps({}, friend));
  expect(events.map((e) => e.kind)).toEqual(["defer", "edit"]);
  expect(events[0]?.options.flags).toBe(MessageFlags.Ephemeral);
  expect(events[1]?.options.content).toBe(linkDeadText());
});

test("a member's /wishlist edits their own list, not the owner's", async () => {
  const friend = memberShop();
  const d = deps({}, friend);
  const { interaction: i } = interaction(FRIEND, {
    options: { getSubcommand: () => "add", getString: (name: string) => (name === "weapon" ? "any" : "Reaver") },
  });
  await handleWishlistCommand(i as unknown as WishlistInteraction, d);
  expect(friend.wishlist).toEqual(["Reaver"]);
  expect(d.ownerWishlist).toEqual([]);
});

test("/link without TOKEN_KEY says linking isn't set up", async () => {
  const { interaction: i, events } = interaction(FRIEND);
  await handleLinkCommand(i, deps(undefined));
  expect(events[0]?.options).toEqual({ content: "Linking isn't set up on this bot.", flags: MessageFlags.Ephemeral });
});

test("/link refused (owner, or no free slot) shows the reason privately", async () => {
  const { interaction: i, events } = interaction(OWNER);
  await handleLinkCommand(i, deps({ startLink: () => ({ ok: false, reason: "You're the bot's owner" }) }));
  expect(events[0]?.options).toEqual({ content: "You're the bot's owner", flags: MessageFlags.Ephemeral });
});

test("/link shows the steps, a Riot sign-in button and a paste button, privately", async () => {
  const { interaction: i, events } = interaction(FRIEND);
  await handleLinkCommand(i, deps({}));
  const reply = events[0]?.options;
  expect(reply.content).toBe(LINK_STEPS);
  expect(reply.flags).toBe(MessageFlags.Ephemeral);
  const [signIn, paste] = reply.components[0].toJSON().components;
  expect(signIn).toMatchObject({ style: ButtonStyle.Link, url: SIGN_IN_URL });
  expect(paste).toMatchObject({ style: ButtonStyle.Primary, custom_id: LINK_PASTE_BUTTON });
});

test("the paste button opens the form; the form is valid for Discord", async () => {
  const { interaction: i, events } = interaction(FRIEND);
  await handlePasteButton(i, deps({}));
  expect(events[0]?.kind).toBe("modal");
  const json = pasteModal().toJSON();
  expect(json.custom_id).toBe(LINK_MODAL);
  expect(JSON.stringify(json)).toContain(`"custom_id":"${LINK_ADDRESS_FIELD}"`);
});

test("the form passes the pasted address on and answers with the Riot ID", async () => {
  let received = "";
  const { interaction: i, events } = interaction(FRIEND);
  await handleLinkModal(
    i,
    deps({
      finishLink: async (_user, pasted) => {
        received = pasted;
        return { ok: true, value: { riotName: "Friend#0001" } };
      },
    }),
  );
  expect(received).toBe(PASTED);
  expect(events.map((e) => e.kind)).toEqual(["defer", "edit"]);
  expect(events[0]?.options.flags).toBe(MessageFlags.Ephemeral);
  expect(events[1]?.options.content).toContain("Linked as **Friend#0001**");
});

test("a refused link shows the reason; an error never echoes the pasted address", async () => {
  const refused = interaction(FRIEND);
  await handleLinkModal(refused.interaction, deps({ finishLink: async () => ({ ok: false, reason: "That Riot account is already linked" }) }));
  expect(refused.events[1]?.options.content).toBe("That Riot account is already linked");

  const failed = interaction(FRIEND);
  await handleLinkModal(
    failed.interaction,
    deps({
      finishLink: async () => {
        throw new Error("network error on auth.riotgames.com");
      },
    }),
  );
  const text = failed.events[1]?.options.content as string;
  expect(text).toContain("Couldn't finish linking");
  expect(text).not.toContain("SECRET-ONE-TIME-CODE");
});

test("/unlink confirms what was deleted, or says why not", async () => {
  const ok = interaction(FRIEND);
  await handleUnlinkCommand(ok.interaction, deps({}));
  expect(ok.events.map((e) => e.kind)).toEqual(["defer", "edit"]);
  expect(ok.events[1]?.options.content).toBe(UNLINKED);

  const owner = interaction(OWNER);
  await handleUnlinkCommand(owner.interaction, deps({ unlink: async () => ({ ok: false, reason: "The owner's account is managed on the server" }) }));
  expect(owner.events[1]?.options.content).toBe("The owner's account is managed on the server");
});
