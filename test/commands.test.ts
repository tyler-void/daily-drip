import { describe, expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import type { StoreSkin } from "../src/catalog.ts";
import {
  ANY_WEAPON,
  type CommandDeps,
  type CommandInteraction,
  handleShopCommand,
  handleWishlistAutocomplete,
  handleWishlistCommand,
  listText,
  resolveSkin,
  type WishlistAutocomplete,
  wishlistChoices,
  type WishlistInteraction,
} from "../src/commands.ts";
import { CookieDeadError, UnexpectedResponseError } from "../src/riot/auth.ts";
import type { ShopSnapshot } from "../src/shop.ts";

const OWNER = "123456789012345678";
const STRANGER = "999999999999999999";
const NOW = Date.parse("2026-11-23T12:00:00Z");

const snapshot = (expiresAt: string, names = ["Imperium Vandal"]): ShopSnapshot => ({
  fetchedAt: "2026-11-23T03:00:00.000Z",
  expiresAt,
  hash: "h",
  offers: names.map((name, i) => ({ levelUuid: `uuid-${i}`, name, iconUrl: null, vp: 2175, tier: null })),
});

// Sorted by name, as storeSkins() returns them.
const SKINS: StoreSkin[] = [
  { name: "Imperium Vandal", weapon: "Vandal" },
  { name: "Prime Classic", weapon: "Classic" },
  { name: "Prime Vandal", weapon: "Vandal" },
  { name: "Reaver Karambit", weapon: "Melee" },
  { name: "Reaver Sheriff", weapon: "Sheriff" },
  { name: "Reaver Vandal", weapon: "Vandal" },
];

type Events = Array<{ kind: string; options?: any }>;

function fakeInteraction(userId = OWNER, sub = "", strings: Record<string, string> = {}) {
  const events: Events = [];
  const interaction: WishlistInteraction = {
    user: { id: userId },
    options: { getSubcommand: () => sub, getString: (name) => strings[name] ?? null },
    reply: async (options) => events.push({ kind: "reply", options }),
    deferReply: async (options) => events.push({ kind: "defer", options }),
    editReply: async (options) => events.push({ kind: "edit", options }),
  };
  return { interaction, events };
}

type TestDeps = CommandDeps & { runs: number; saved: string[][]; wishlist: string[] };

function deps(overrides: Partial<CommandDeps> = {}): TestDeps {
  const d: TestDeps = {
    runs: 0,
    saved: [] as string[][],
    wishlist: [] as string[],
    ownerId: OWNER,
    cookieFile: "config/riot-cookie",
    currentSnapshot: (): ShopSnapshot | null => null,
    runShop: async () => {
      d.runs++;
      return snapshot("2026-11-24T00:00:00.000Z", ["Fresh Skin"]);
    },
    getWishlist: () => d.wishlist,
    setWishlist: async (entries: string[]) => {
      d.saved.push(entries);
      d.wishlist = entries;
    },
    storeSkins: () => SKINS,
    now: () => NOW,
    ...overrides,
  };
  return d;
}

// ---------- /shop ----------

describe("/shop", () => {
  test("anyone but the owner gets a private refusal and no run", async () => {
    const { interaction, events } = fakeInteraction(STRANGER);
    const d = deps();
    await handleShopCommand(interaction as CommandInteraction, d);
    expect(events).toEqual([{ kind: "reply", options: { content: "Sorry, this bot only answers its owner.", flags: MessageFlags.Ephemeral } }]);
    expect(d.runs).toBe(0);
  });

  test("a snapshot that has not expired is answered at once, without calling Riot", async () => {
    const { interaction, events } = fakeInteraction();
    const d = deps({ currentSnapshot: () => snapshot("2026-11-24T00:00:00.000Z") });
    await handleShopCommand(interaction, d);
    expect(d.runs).toBe(0);
    expect(events).toHaveLength(1);
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
    const runShop = async (): Promise<ShopSnapshot> => {
      throw new CookieDeadError("login redirect");
    };
    await handleShopCommand(interaction, deps({ runShop }));
    expect(events[1]?.options.content).toContain("Riot cookie expired");
  });

  test("other failures answer with the reason, redacted", async () => {
    const { interaction, events } = fakeInteraction();
    const runShop = async (): Promise<ShopSnapshot> => {
      throw new UnexpectedResponseError("E6 storefront returned 500 eyJhbGciOiJIUzI1NiJ9.e30.sig");
    };
    await handleShopCommand(interaction, deps({ runShop }));
    expect(events[1]?.options.content).toBe("Couldn't fetch the shop: E6 storefront returned 500 [jwt]");
  });
});

// ---------- /wishlist ----------

describe("resolveSkin", () => {
  test("Any weapon keeps the text as typed, so a partial name matches every gun", () => {
    expect(resolveSkin(ANY_WEAPON, " Reaver ", SKINS)).toEqual({ ok: true, entry: "Reaver" });
  });

  test("a gun plus a full name gives that skin, with the catalog's spelling", () => {
    expect(resolveSkin("Vandal", "prime vandal", SKINS)).toEqual({ ok: true, entry: "Prime Vandal" });
  });

  test("a gun plus a part that only one of its skins has gives that skin", () => {
    expect(resolveSkin("Vandal", "reaver", SKINS)).toEqual({ ok: true, entry: "Reaver Vandal" });
    expect(resolveSkin("Melee", "reaver", SKINS)).toEqual({ ok: true, entry: "Reaver Karambit" });
  });

  test("a gun plus an ambiguous or unknown part is refused with a hint", () => {
    const ambiguous = resolveSkin("Vandal", "a", SKINS);
    expect(ambiguous.ok).toBe(false);
    expect(!ambiguous.ok && ambiguous.reason).toContain('choose "Any weapon"');
    const unknown = resolveSkin("Vandal", "Kuronami", SKINS);
    expect(!unknown.ok && unknown.reason).toContain("No Vandal skin matches");
  });

  test("without a catalog the text is taken as it is", () => {
    expect(resolveSkin("Vandal", "Kuronami", [])).toEqual({ ok: true, entry: "Kuronami" });
  });
});

describe("/wishlist", () => {
  test("strangers are refused and nothing changes", async () => {
    const { interaction, events } = fakeInteraction(STRANGER, "clear");
    const d = deps();
    d.wishlist = ["Reaver"];
    await handleWishlistCommand(interaction, d);
    expect(events[0]?.options.flags).toBe(MessageFlags.Ephemeral);
    expect(d.saved).toHaveLength(0);
  });

  test("add saves the entry and replies privately with the list", async () => {
    const { interaction, events } = fakeInteraction(OWNER, "add", { weapon: "Vandal", skin: "Reaver Vandal" });
    const d = deps();
    await handleWishlistCommand(interaction, d);
    expect(d.saved).toEqual([["Reaver Vandal"]]);
    expect(events[0]).toEqual({ kind: "defer", options: { flags: MessageFlags.Ephemeral } });
    expect(events[1]?.options.content).toStartWith("Added **Reaver Vandal**.");
  });

  test("add refuses a duplicate without saving", async () => {
    const { interaction, events } = fakeInteraction(OWNER, "add", { weapon: ANY_WEAPON, skin: "reaver" });
    const d = deps();
    d.wishlist = ["Reaver"];
    await handleWishlistCommand(interaction, d);
    expect(d.saved).toHaveLength(0);
    expect(events[1]?.options.content).toBe("**Reaver** is already on your wishlist.");
  });

  test("remove takes an entry off", async () => {
    const { interaction, events } = fakeInteraction(OWNER, "remove", { entry: "prime vandal" });
    const d = deps();
    d.wishlist = ["Reaver", "Prime Vandal"];
    await handleWishlistCommand(interaction, d);
    expect(d.saved).toEqual([["Reaver"]]);
    expect(events[1]?.options.content).toStartWith("Removed **Prime Vandal**.");
  });

  test("list marks entries that are in today's shop", async () => {
    const { interaction, events } = fakeInteraction(OWNER, "list");
    const d = deps({ currentSnapshot: () => snapshot("2026-11-24T00:00:00.000Z", ["Imperium Vandal", "Reaver Sheriff"]) });
    d.wishlist = ["Reaver", "Prime Vandal"];
    await handleWishlistCommand(interaction, d);
    expect(events[1]?.options.content).toBe("**Your wishlist** (2/25)\n- Reaver: **in today's shop** (Reaver Sheriff)\n- Prime Vandal");
  });

  test("clear empties the list", async () => {
    const { interaction, events } = fakeInteraction(OWNER, "clear");
    const d = deps();
    d.wishlist = ["Reaver", "Prime Vandal"];
    await handleWishlistCommand(interaction, d);
    expect(d.saved).toEqual([[]]);
    expect(events[1]?.options.content).toBe("Cleared your wishlist (2 entries).");
  });

  test("an empty list says how to add one", () => {
    expect(listText([], [])).toBe("Your wishlist is empty. Add a skin with `/wishlist add`.");
  });
});

describe("/wishlist autocomplete", () => {
  test("weapon: 'Any weapon' first, then the guns from the catalog", () => {
    const choices = wishlistChoices("weapon", "", null, deps());
    expect(choices.map((c) => c.value)).toEqual([ANY_WEAPON, "Classic", "Melee", "Sheriff", "Vandal"]);
    expect(wishlistChoices("weapon", "va", null, deps()).map((c) => c.value)).toEqual([ANY_WEAPON, "Vandal"]);
  });

  test("skin with a gun chosen: only that gun's skins", () => {
    expect(wishlistChoices("skin", "", "Vandal", deps()).map((c) => c.value)).toEqual(["Imperium Vandal", "Prime Vandal", "Reaver Vandal"]);
    expect(wishlistChoices("skin", "rea", "Vandal", deps()).map((c) => c.value)).toEqual(["Reaver Vandal"]);
  });

  test("skin with Any weapon: the typed text first, then full names from every gun", () => {
    const choices = wishlistChoices("skin", "reaver", ANY_WEAPON, deps());
    expect(choices[0]).toEqual({ name: "reaver (every skin with this in its name)", value: "reaver" });
    expect(choices.slice(1).map((c) => c.value)).toEqual(["Reaver Karambit", "Reaver Sheriff", "Reaver Vandal"]);
  });

  test("entry: the current wishlist", () => {
    const d = deps();
    d.wishlist = ["Reaver", "Prime Vandal"];
    expect(wishlistChoices("entry", "pri", null, d).map((c) => c.value)).toEqual(["Prime Vandal"]);
  });

  test("strangers get no suggestions", async () => {
    const responses: unknown[] = [];
    const interaction: WishlistAutocomplete = {
      user: { id: STRANGER },
      options: { getFocused: () => ({ name: "skin", value: "rea" }), getString: () => null },
      respond: async (choices) => responses.push(choices),
    };
    await handleWishlistAutocomplete(interaction, deps());
    expect(responses).toEqual([[]]);
  });

  test("choices are cut to Discord's 100-character limit", async () => {
    const responses: Array<Array<{ name: string; value: string }>> = [];
    const long = "x".repeat(150);
    const interaction: WishlistAutocomplete = {
      user: { id: OWNER },
      options: { getFocused: () => ({ name: "entry", value: "" }), getString: () => null },
      respond: async (choices) => responses.push(choices),
    };
    const d = deps();
    d.wishlist = [long];
    await handleWishlistAutocomplete(interaction, d);
    expect(responses[0]?.[0]?.name.length).toBe(100);
    expect(responses[0]?.[0]?.value.length).toBe(100);
  });
});
