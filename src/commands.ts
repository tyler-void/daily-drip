// Slash commands (spec: Bot; Accounts).
// /shop answers from the cached snapshot while it has not expired; otherwise it runs under the run lock.
// /wishlist add|remove|list|clear manages the wishlist; add picks a gun, then one of its current skins.
// Both answer the owner, and linked members about their own account (privately). /link and /unlink
// exist only when member linking is set up (TOKEN_KEY).

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  Events,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { Result } from "./accounts.ts";
import { cookieDeadText } from "./alerts.ts";
import type { StoreSkin } from "./catalog.ts";
import { log, redact } from "./log.ts";
import { linkDeadText } from "./members.ts";
import { type DiscordMessage, shopMessage } from "./notify/discord.ts";
import { CookieDeadError } from "./riot/auth.ts";
import { LoginDeadError } from "./riot/login.ts";
import type { ShopSnapshot } from "./shop.ts";
import { addEntry, MAX_ENTRIES, MAX_ENTRY_LENGTH, matchWishlist, removeEntry, suggest } from "./wishlist.ts";

export const ANY_WEAPON = "any";
const NOT_OWNER = "Sorry, this bot only answers its owner.";
const NOT_LINKED = "You aren't linked to this bot yet. Run `/link` to connect your Riot account.";
const LINKING_OFF = "Linking isn't set up on this bot.";

export const LINK_PASTE_BUTTON = "link:paste";
export const LINK_MODAL = "link:modal";
export const LINK_ADDRESS_FIELD = "address";

export const shopCommand = new SlashCommandBuilder().setName("shop").setDescription("Show today's Valorant shop");
export const linkCommand = new SlashCommandBuilder().setName("link").setDescription("Link your Riot account to get your own daily shop");
export const unlinkCommand = new SlashCommandBuilder()
  .setName("unlink")
  .setDescription("Unlink your Riot account; the bot deletes what it holds about it");

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

/**
 * Guild commands show up at once, unlike global ones. `set` replaces the whole list, so turning
 * linking off also removes /link and /unlink.
 */
export async function registerCommands(client: Client<true>, guildId: string, linking = false): Promise<void> {
  const guild = await client.guilds.fetch(guildId);
  const commands = [shopCommand, wishlistCommand, ...(linking ? [linkCommand, unlinkCommand] : [])];
  await guild.commands.set(commands.map((c) => c.toJSON()));
}

/** What /shop and /wishlist use for one Discord user: the owner's account, or a member's. */
export interface UserShop {
  currentSnapshot(): ShopSnapshot | null;
  /** One run under the run lock. */
  runShop(): Promise<ShopSnapshot>;
  getWishlist(): string[];
  /** Saves under the run lock. */
  setWishlist(entries: string[]): Promise<void>;
}

/** Members' side of the commands. Absent when linking isn't set up. */
export interface MemberCommands {
  /** The member's shop, or null if this Discord user hasn't linked. */
  shopFor(userId: string): UserShop | null;
  /** May this user link? If so, a fresh sign-in link. */
  startLink(userId: string): Result<{ url: string }>;
  /** The pasted address -> a linked member. Under the run lock. */
  finishLink(user: { id: string; username: string }, pasted: string): Promise<Result<{ riotName: string | null }>>;
  /** Deletes the member's entry: sign-in token, shop and wishlist. Under the run lock. */
  unlink(userId: string): Promise<Result<unknown>>;
}

export interface CommandDeps {
  ownerId: string;
  cookieFile: string;
  // The owner's account:
  currentSnapshot(): ShopSnapshot | null;
  /** One run under the run lock. */
  runShop(): Promise<ShopSnapshot>;
  getWishlist(): string[];
  /** Saves under the run lock. */
  setWishlist(entries: string[]): Promise<void>;
  /** Current store skins from the catalog, for autocomplete. */
  storeSkins(): StoreSkin[];
  members?: MemberCommands;
  /** A Discord user's linked Riot ID, shown on their shop; null while unknown. */
  riotName?: (userId: string) => string | null;
  now?: () => number;
}

/** The owner's account, a linked member's, or null for anyone else. */
function shopFor(userId: string, deps: CommandDeps): UserShop | null {
  if (userId === deps.ownerId) return deps;
  return deps.members?.shopFor(userId) ?? null;
}

const refusal = (deps: CommandDeps) => (deps.members ? NOT_LINKED : NOT_OWNER);

// ---------- /shop ----------

/** The parts of a slash-command interaction the handlers use, so tests can pass a fake. */
export interface CommandInteraction {
  user: { id: string };
  reply(options: Partial<DiscordMessage> & { flags?: number }): Promise<unknown>;
  deferReply(options?: { flags?: number }): Promise<unknown>;
  editReply(options: DiscordMessage): Promise<unknown>;
}

export async function handleShopCommand(interaction: CommandInteraction, deps: CommandDeps): Promise<void> {
  const shop = shopFor(interaction.user.id, deps);
  if (!shop) {
    await interaction.reply({ content: refusal(deps), flags: MessageFlags.Ephemeral });
    return;
  }
  // Everyone's shop is public, like the daily post; the reply names whose it is, without a ping.
  const holder = { userId: interaction.user.id, ping: false, riotName: deps.riotName?.(interaction.user.id) ?? null };
  const cached = liveSnapshot(shop, deps);
  if (cached) {
    await interaction.reply(shopMessage(cached, holder));
    return;
  }
  // A run takes a second or two; Discord wants an answer within 3 s, so defer first.
  await interaction.deferReply();
  try {
    await interaction.editReply(shopMessage(await shop.runShop(), holder));
  } catch (err) {
    const text =
      err instanceof CookieDeadError
        ? cookieDeadText(deps.cookieFile)
        : err instanceof LoginDeadError
          ? linkDeadText()
          : redact(`Couldn't fetch the shop: ${err instanceof Error ? err.message : String(err)}`);
    await interaction.editReply(plain(text));
  }
}

// ---------- /wishlist ----------

export interface WishlistInteraction extends CommandInteraction {
  options: { getSubcommand(): string; getString(name: string): string | null };
}

export async function handleWishlistCommand(interaction: WishlistInteraction, deps: CommandDeps): Promise<void> {
  const shop = shopFor(interaction.user.id, deps);
  if (!shop) {
    await interaction.reply({ content: refusal(deps), flags: MessageFlags.Ephemeral });
    return;
  }
  // Private replies; deferred because saving waits for the run lock.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const entries = shop.getWishlist();
  const offers = liveSnapshot(shop, deps)?.offers ?? [];
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
      await shop.setWishlist(change.entries);
      text = `Added **${change.entry}**.\n\n${listText(change.entries, offers)}`;
      break;
    }
    case "remove": {
      const change = removeEntry(entries, interaction.options.getString("entry") ?? "");
      if (!change.ok) {
        text = change.reason;
        break;
      }
      await shop.setWishlist(change.entries);
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
      await shop.setWishlist([]);
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
  const shop = shopFor(interaction.user.id, deps);
  if (!shop) {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused(true);
  const choices = wishlistChoices(focused.name, String(focused.value), interaction.options.getString("weapon"), deps, shop.getWishlist());
  await interaction.respond(choices.map(limitChoice));
}

/** At most 25 suggestions (Discord's limit) for the focused option. `wishlist` is the asking user's. */
export function wishlistChoices(option: string, typed: string, weapon: string | null, deps: CommandDeps, wishlist: string[] = deps.getWishlist()): Choice[] {
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
  if (option === "entry") return suggest(wishlist, typed, 25).map((e) => ({ name: e, value: e }));
  return [];
}

// ---------- /link and /unlink ----------

export const LINK_STEPS = [
  "**Link your Riot account**",
  "1. Press **Sign in with Riot**. It opens Riot's own sign-in page: sign in there, never in Discord.",
  "2. Your browser then lands on a page that fails to load. Copy its whole address: click the address bar, then Ctrl+A and Ctrl+C (on a phone: tap the address bar, select all, Copy). It starts with `localhost/redirect?` and contains `code=`.",
  "3. Press **Paste the address** and paste it within a few minutes.",
  "",
  "After each reset, your shop is posted in this server's shop channel, for everyone to see, and pings you. Your wishlist stays private: hits come to you by DM.",
  "The bot keeps a sign-in token for your account, encrypted, and uses it only to read your daily shop. `/unlink` deletes it.",
].join("\n");

export interface ReplyInteraction {
  user: { id: string; username: string };
  reply(options: { content: string; components?: ActionRowBuilder<ButtonBuilder>[]; flags?: number }): Promise<unknown>;
}

export async function handleLinkCommand(interaction: ReplyInteraction, deps: CommandDeps): Promise<void> {
  if (!deps.members) {
    await interaction.reply({ content: LINKING_OFF, flags: MessageFlags.Ephemeral });
    return;
  }
  const start = deps.members.startLink(interaction.user.id);
  if (!start.ok) {
    await interaction.reply({ content: start.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(start.value.url).setLabel("Sign in with Riot"),
    new ButtonBuilder().setStyle(ButtonStyle.Primary).setCustomId(LINK_PASTE_BUTTON).setLabel("Paste the address"),
  );
  await interaction.reply({ content: LINK_STEPS, components: [row], flags: MessageFlags.Ephemeral });
}

/** The form for the pasted address. Discord allows up to 4,000 characters; the address is far shorter. */
export function pasteModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(LINK_MODAL)
    .setTitle("Link your Riot account")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("The address from your browser")
        .setDescription("It starts with http://localhost/redirect? and contains code=")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(LINK_ADDRESS_FIELD)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000)
            .setPlaceholder("http://localhost/redirect?...&code=..."),
        ),
    );
}

export interface PasteButtonInteraction {
  showModal(modal: ModalBuilder): Promise<unknown>;
  reply(options: { content: string; flags?: number }): Promise<unknown>;
}

export async function handlePasteButton(interaction: PasteButtonInteraction, deps: CommandDeps): Promise<void> {
  if (!deps.members) {
    await interaction.reply({ content: LINKING_OFF, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.showModal(pasteModal());
}

export interface LinkModalInteraction {
  user: { id: string; username: string };
  fields: { getTextInputValue(customId: string): string };
  deferReply(options?: { flags?: number }): Promise<unknown>;
  editReply(options: DiscordMessage): Promise<unknown>;
}

export async function handleLinkModal(interaction: LinkModalInteraction, deps: CommandDeps): Promise<void> {
  // Linking signs in to Riot, which takes longer than Discord's 3 s.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!deps.members) {
    await interaction.editReply(plain(LINKING_OFF));
    return;
  }
  let text: string;
  try {
    // The pasted address holds a one-time code: it goes to completeLink and nowhere else.
    const pasted = interaction.fields.getTextInputValue(LINK_ADDRESS_FIELD);
    const result = await deps.members.finishLink({ id: interaction.user.id, username: interaction.user.username }, pasted);
    text = result.ok
      ? `Linked${result.value.riotName ? ` as **${result.value.riotName}**` : ""}. Your shop is posted in the shop channel after each reset, with a ping; wishlist hits come by DM. \`/shop\` shows it now.`
      : result.reason;
  } catch (err) {
    text = redact(`Couldn't finish linking: ${err instanceof Error ? err.message : String(err)}. Try \`/link\` again.`);
  }
  await interaction.editReply(plain(text));
}

export interface UnlinkInteraction {
  user: { id: string };
  deferReply(options?: { flags?: number }): Promise<unknown>;
  editReply(options: DiscordMessage): Promise<unknown>;
  reply(options: { content: string; flags?: number }): Promise<unknown>;
}

export const UNLINKED =
  "Unlinked. The bot deleted your sign-in token, shop and wishlist. To end the Riot sign-in itself as well, choose **Sign out of all devices** in your Riot account settings.";

export async function handleUnlinkCommand(interaction: UnlinkInteraction, deps: CommandDeps): Promise<void> {
  if (!deps.members) {
    await interaction.reply({ content: LINKING_OFF, flags: MessageFlags.Ephemeral });
    return;
  }
  // Deferred: deleting waits for the run lock.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await deps.members.unlink(interaction.user.id);
  await interaction.editReply(plain(result.ok ? UNLINKED : result.reason));
}

// ---------- wiring ----------

export function listenForCommands(client: Client, deps: CommandDeps): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === "wishlist") await handleWishlistAutocomplete(interaction, deps);
        return;
      }
      if (interaction.isButton()) {
        if (interaction.customId === LINK_PASTE_BUTTON) await handlePasteButton(interaction, deps);
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId === LINK_MODAL) await handleLinkModal(interaction, deps);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === "shop") await handleShopCommand(interaction, deps);
      else if (interaction.commandName === "wishlist") await handleWishlistCommand(interaction, deps);
      else if (interaction.commandName === "link") await handleLinkCommand(interaction, deps);
      else if (interaction.commandName === "unlink") await handleUnlinkCommand(interaction, deps);
    } catch (err) {
      // Error messages only: never the interaction, which can hold a pasted sign-in address.
      log.error("command failed", { error: err });
    }
  });
}

function liveSnapshot(shop: UserShop, deps: CommandDeps): ShopSnapshot | null {
  const snapshot = shop.currentSnapshot();
  return snapshot && Date.parse(snapshot.expiresAt) > (deps.now?.() ?? Date.now()) ? snapshot : null;
}

function plain(content: string): DiscordMessage {
  return { content, embeds: [], allowedMentions: { parse: [] } };
}

// Discord: choice names and values are 1-100 characters.
function limitChoice(choice: Choice): Choice {
  return { name: choice.name.slice(0, 100), value: choice.value.slice(0, 100) };
}
