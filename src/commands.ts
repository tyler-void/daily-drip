// Slash commands (spec: Bot). Both are owner-only.
// /shop answers from the cached snapshot while it has not expired; otherwise it runs under the run lock.
// /wishlist add|remove|list|clear manages the wishlist; add picks a gun, then one of its current skins.

import { type Client, Events, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { StoreSkin } from "./catalog.ts";
import { log, redact } from "./log.ts";
import { cookieDeadText, type DiscordMessage, shopMessage } from "./notify/discord.ts";
import { CookieDeadError } from "./riot/auth.ts";
import type { ShopSnapshot } from "./shop.ts";
import { addEntry, MAX_ENTRIES, MAX_ENTRY_LENGTH, matchWishlist, removeEntry, suggest } from "./wishlist.ts";

export const ANY_WEAPON = "any";
const NOT_OWNER = "Sorry, this bot only answers its owner.";

export const shopCommand = new SlashCommandBuilder().setName("shop").setDescription("Show today's Valorant shop");

export const wishlistCommand = new SlashCommandBuilder()
  .setName("wishlist")
  .setDescription("The skins you get pinged for when they show up in your shop")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a skin: pick the gun, then the skin")
      .addStringOption((o) =>
        o.setName("weapon").setDescription('The gun, or "Any weapon" to match a name on every gun').setRequired(true).setAutocomplete(true),
      )
      .addStringOption((o) =>
        o
          .setName("skin")
          .setDescription('The skin; with "Any weapon", part of a name works ("Reaver" = every Reaver skin)')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(MAX_ENTRY_LENGTH),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Remove an entry")
      .addStringOption((o) => o.setName("entry").setDescription("The entry to remove").setRequired(true).setAutocomplete(true)),
  )
  .addSubcommand((sub) => sub.setName("list").setDescription("Show your wishlist, and which entries are in today's shop"))
  .addSubcommand((sub) => sub.setName("clear").setDescription("Remove every entry"));

/** Guild commands show up at once, unlike global ones. */
export async function registerCommands(client: Client<true>, guildId: string): Promise<void> {
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([shopCommand.toJSON(), wishlistCommand.toJSON()]);
}

export interface CommandDeps {
  ownerId: string;
  cookieFile: string;
  currentSnapshot(): ShopSnapshot | null;
  /** One run under the run lock. */
  runShop(): Promise<ShopSnapshot>;
  getWishlist(): string[];
  /** Saves under the run lock. */
  setWishlist(entries: string[]): Promise<void>;
  /** Current store skins from the catalog, for autocomplete. */
  storeSkins(): StoreSkin[];
  now?: () => number;
}

// ---------- /shop ----------

/** The parts of a slash-command interaction the handlers use, so tests can pass a fake. */
export interface CommandInteraction {
  user: { id: string };
  reply(options: Partial<DiscordMessage> & { flags?: number }): Promise<unknown>;
  deferReply(options?: { flags?: number }): Promise<unknown>;
  editReply(options: DiscordMessage): Promise<unknown>;
}

export async function handleShopCommand(interaction: CommandInteraction, deps: CommandDeps): Promise<void> {
  if (interaction.user.id !== deps.ownerId) {
    await interaction.reply({ content: NOT_OWNER, flags: MessageFlags.Ephemeral });
    return;
  }
  const cached = liveSnapshot(deps);
  if (cached) {
    await interaction.reply(shopMessage(cached));
    return;
  }
  // A run takes a second or two; Discord wants an answer within 3 s, so defer first.
  await interaction.deferReply();
  try {
    await interaction.editReply(shopMessage(await deps.runShop()));
  } catch (err) {
    const text =
      err instanceof CookieDeadError ? cookieDeadText(deps.cookieFile) : redact(`Couldn't fetch the shop: ${err instanceof Error ? err.message : String(err)}`);
    await interaction.editReply(plain(text));
  }
}

// ---------- /wishlist ----------

export interface WishlistInteraction extends CommandInteraction {
  options: { getSubcommand(): string; getString(name: string): string | null };
}

export async function handleWishlistCommand(interaction: WishlistInteraction, deps: CommandDeps): Promise<void> {
  if (interaction.user.id !== deps.ownerId) {
    await interaction.reply({ content: NOT_OWNER, flags: MessageFlags.Ephemeral });
    return;
  }
  // Private replies; deferred because saving waits for the run lock.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const entries = deps.getWishlist();
  const offers = liveSnapshot(deps)?.offers ?? [];
  let text: string;

  switch (interaction.options.getSubcommand()) {
    case "add": {
      const resolved = resolveSkin(interaction.options.getString("weapon") ?? ANY_WEAPON, interaction.options.getString("skin") ?? "", deps.storeSkins());
      if (!resolved.ok) {
        text = resolved.reason;
        break;
      }
      const change = addEntry(entries, resolved.entry);
      if (!change.ok) {
        text = change.reason;
        break;
      }
      await deps.setWishlist(change.entries);
      text = `Added **${change.entry}**.\n\n${listText(change.entries, offers)}`;
      break;
    }
    case "remove": {
      const change = removeEntry(entries, interaction.options.getString("entry") ?? "");
      if (!change.ok) {
        text = change.reason;
        break;
      }
      await deps.setWishlist(change.entries);
      text = `Removed **${change.entry}**.\n\n${listText(change.entries, offers)}`;
      break;
    }
    case "list":
      text = listText(entries, offers);
      break;
    case "clear":
      if (entries.length === 0) {
        text = "Your wishlist is already empty.";
        break;
      }
      await deps.setWishlist([]);
      text = `Cleared your wishlist (${entries.length} ${entries.length === 1 ? "entry" : "entries"}).`;
      break;
    default:
      text = "Unknown subcommand.";
  }
  await interaction.editReply(plain(text));
}

/**
 * With a specific gun, the entry must be one of its skins: a full name, or a part of a name
 * that only one of its skins contains. With "Any weapon", any text of 2+ characters works.
 */
export function resolveSkin(weapon: string, skinText: string, skins: StoreSkin[]): { ok: true; entry: string } | { ok: false; reason: string } {
  const typed = skinText.trim();
  const gunSkins = skins.filter((s) => s.weapon.toLowerCase() === weapon.toLowerCase());
  // No catalog yet, or "Any weapon": take the text as it is.
  if (weapon === ANY_WEAPON || gunSkins.length === 0) return { ok: true, entry: typed };
  const exact = gunSkins.find((s) => s.name.toLowerCase() === typed.toLowerCase());
  if (exact) return { ok: true, entry: exact.name };
  const partial = gunSkins.filter((s) => s.name.toLowerCase().includes(typed.toLowerCase()));
  const [only] = partial;
  if (partial.length === 1 && only) return { ok: true, entry: only.name };
  return {
    ok: false,
    reason:
      partial.length === 0
        ? `No ${gunSkins[0]?.weapon ?? weapon} skin matches **${typed}**. Pick one of the suggestions.`
        : `**${typed}** matches ${partial.length} ${gunSkins[0]?.weapon ?? weapon} skins. Pick one of the suggestions, or choose "Any weapon" to match all of them.`,
  };
}

export function listText(entries: string[], todaysOffers: ShopSnapshot["offers"]): string {
  if (entries.length === 0) return "Your wishlist is empty. Add a skin with `/wishlist add`.";
  const lines = entries.map((entry) => {
    const hits = matchWishlist(todaysOffers, [entry]);
    return hits.length > 0 ? `- ${entry}: **in today's shop** (${hits.map((h) => h.name).join(", ")})` : `- ${entry}`;
  });
  return `**Your wishlist** (${entries.length}/${MAX_ENTRIES})\n${lines.join("\n")}`;
}

// ---------- autocomplete ----------

export interface Choice {
  name: string;
  value: string;
}

export interface WishlistAutocomplete {
  user: { id: string };
  options: { getFocused(full: true): { name: string; value: string }; getString(name: string): string | null };
  respond(choices: Choice[]): Promise<unknown>;
}

export async function handleWishlistAutocomplete(interaction: WishlistAutocomplete, deps: CommandDeps): Promise<void> {
  if (interaction.user.id !== deps.ownerId) {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused(true);
  await interaction.respond(wishlistChoices(focused.name, String(focused.value), interaction.options.getString("weapon"), deps).map(limitChoice));
}

/** At most 25 suggestions (Discord's limit) for the focused option. */
export function wishlistChoices(option: string, typed: string, weapon: string | null, deps: CommandDeps): Choice[] {
  const skins = deps.storeSkins();
  if (option === "weapon") {
    const weapons = [...new Set(skins.map((s) => s.weapon))].sort((a, b) => a.localeCompare(b));
    const any: Choice = { name: "Any weapon (match the name on every gun)", value: ANY_WEAPON };
    return [any, ...suggest(weapons, typed, 24).map((w) => ({ name: w, value: w }))];
  }
  if (option === "skin") {
    const gunSkins = weapon && weapon !== ANY_WEAPON ? skins.filter((s) => s.weapon === weapon) : [];
    if (gunSkins.length > 0) return suggest(gunSkins.map((s) => s.name), typed, 25).map((n) => ({ name: n, value: n }));
    // "Any weapon": offer the typed text itself as a partial match, then full names.
    const names = suggest(skins.map((s) => s.name), typed, 24).map((n) => ({ name: n, value: n }));
    const text = typed.trim();
    return text.length >= 2 ? [{ name: `${text} (every skin with this in its name)`, value: text }, ...names] : names;
  }
  if (option === "entry") return suggest(deps.getWishlist(), typed, 25).map((e) => ({ name: e, value: e }));
  return [];
}

// ---------- wiring ----------

export function listenForCommands(client: Client, deps: CommandDeps): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === "wishlist") await handleWishlistAutocomplete(interaction, deps);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === "shop") await handleShopCommand(interaction, deps);
      else if (interaction.commandName === "wishlist") await handleWishlistCommand(interaction, deps);
    } catch (err) {
      log.error("command failed", { error: err });
    }
  });
}

function liveSnapshot(deps: CommandDeps): ShopSnapshot | null {
  const snapshot = deps.currentSnapshot();
  return snapshot && Date.parse(snapshot.expiresAt) > (deps.now?.() ?? Date.now()) ? snapshot : null;
}

function plain(content: string): DiscordMessage {
  return { content, embeds: [], allowedMentions: { parse: [] } };
}

// Discord: choice names and values are 1-100 characters.
function limitChoice(choice: Choice): Choice {
  return { name: choice.name.slice(0, 100), value: choice.value.slice(0, 100) };
}
