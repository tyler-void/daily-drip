// Discord: the bot client, the message layouts and the Notifier (spec: Messages, Bot).

import {
  type APIEmbed,
  Client,
  EmbedBuilder,
  Events,
  escapeMarkdown,
  GatewayIntentBits,
  type MessageMentionOptions,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { log } from "../log.ts";
import type { ShopOffer, ShopSnapshot } from "../shop.ts";
import type { Notifier } from "./notifier.ts";

export interface DiscordMessage {
  content: string;
  embeds: APIEmbed[];
  allowedMentions: MessageMentionOptions;
  /** Attachments, e.g. the recap card; an embed shows one with image.url "attachment://<name>". */
  files?: { attachment: Buffer; name: string }[];
}

const vp = (amount: number) => `${new Intl.NumberFormat("en-US").format(amount)} VP`;

/** Whose shop a post shows, and whether it pings them: the post after a reset does, a /shop reply doesn't. */
export interface ShopHolder {
  userId: string;
  ping: boolean;
  /** Their Riot ID, shown next to the mention; omitted while unknown. */
  riotName?: string | null;
}

/**
 * One message, one embed per skin; the text is a live countdown to the reset. With `holder`, it
 * names whose shop it is, since everyone's shop is posted in the same channel.
 */
export function shopMessage(snapshot: ShopSnapshot, holder?: ShopHolder): DiscordMessage {
  const resetsAt = Math.floor(Date.parse(snapshot.expiresAt) / 1000);
  const embeds = snapshot.offers.map((offer) => offerEmbed(offer));
  // <t:…:R> renders as "in 20 hours" in each viewer's own time zone, and keeps counting.
  const countdown = `resets <t:${resetsAt}:R>`;
  if (!holder) return { content: `**Daily shop** · ${countdown}`, embeds, allowedMentions: { parse: [] } };
  // Escaped, so a Riot ID can't change the message's formatting.
  const riotId = holder.riotName ? ` (${escapeMarkdown(holder.riotName)})` : "";
  return {
    content: `<@${holder.userId}>'s **daily shop**${riotId} · ${countdown}`,
    embeds,
    // Without the ping, the mention still shows the name; it just doesn't notify.
    allowedMentions: holder.ping ? { users: [holder.userId] } : { parse: [] },
  };
}

/**
 * One skin's card: name (linking to Fandom), price, links, image, tier colour. `showPrice: false`
 * leaves the price out, for /preview, which isn't about a shop.
 */
export function offerEmbed(offer: ShopOffer, showPrice = true): APIEmbed {
  const price = showPrice ? (offer.vp !== null ? `**${vp(offer.vp)}**` : "Price unknown") : "";
  const links = offer.links;
  // The title links to the collection's Fandom page; clicking the image always opens the image.
  const linkLine = links ? `[Fandom](${links.fandom}) · [Trailer](${links.trailer})${links.preview ? ` · [Preview](${links.preview})` : ""}` : "";
  const description = [price, linkLine].filter(Boolean).join("\n");
  const embed = new EmbedBuilder().setTitle(offer.name);
  if (description) embed.setDescription(description);
  if (links) embed.setURL(links.fandom);
  if (offer.iconUrl) embed.setImage(offer.iconUrl);
  const color = offer.tier ? Number.parseInt(offer.tier.color, 16) : Number.NaN;
  if (offer.tier && Number.isFinite(color)) embed.setColor(color).setFooter({ text: offer.tier.name });
  return embed.toJSON();
}

/**
 * The /preview card; the video follows as its own message (previewMessage). `level` is the chosen
 * level and the skin's level count; without it, the video is the fully upgraded one.
 */
export function skinCardMessage(offer: ShopOffer, level?: { level: number; label: string; of: number }): DiscordMessage {
  const which = level ? `level ${level.level} of ${level.of}: ${escapeMarkdown(level.label)}` : "fully upgraded";
  const note = offer.links?.preview ? "" : `\nRiot has no preview video for this ${level ? "level" : "skin"}; try the trailer.`;
  return { content: `**Preview** · ${escapeMarkdown(offer.name)} · ${which}${note}`, embeds: [offerEmbed(offer, false)], allowedMentions: { parse: [] } };
}

export function wishlistMessage(hits: ShopOffer[], ownerId: string): DiscordMessage {
  const names = hits.map((h) => `**${h.name}**${h.vp !== null ? ` (${vp(h.vp)})` : ""}`).join(", ");
  const verb = hits.length === 1 ? "is" : "are";
  return { content: `<@${ownerId}> Wishlist hit: ${names} ${verb} in your shop today.`, embeds: [], allowedMentions: { users: [ownerId] } };
}

export function alertMessage(text: string, ownerId: string): DiscordMessage {
  return { content: `<@${ownerId}> ${text}`, embeds: [], allowedMentions: { users: [ownerId] } };
}

/** The permissions the spec's invite step grants (spec: Inviting the bot). */
export const BOT_PERMISSIONS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks;

/** The invite link for this bot, with the server preselected. */
export function inviteUrl(applicationId: string, guildId: string): string {
  return (
    `https://discord.com/oauth2/authorize?client_id=${applicationId}` +
    `&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}&guild_id=${guildId}`
  );
}

/** The bot is not set up the way the spec says. The message says what to fix. */
export class DiscordSetupError extends Error {
  name = "DiscordSetupError";
}

/** Check at startup that the bot is in the server and can post in the channel. */
export async function checkDiscordSetup(client: Client<true>, guildId: string, channelId: string): Promise<void> {
  if (!client.guilds.cache.has(guildId)) {
    throw new DiscordSetupError(
      `the bot is not in the server DISCORD_GUILD_ID=${guildId}, or that ID is wrong. ` +
        `Add it by opening ${inviteUrl(client.application.id, guildId)}`,
    );
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.isDMBased() || channel.guildId !== guildId) {
    throw new DiscordSetupError(`DISCORD_CHANNEL_ID=${channelId} is not a channel in that server; copy the channel's ID again`);
  }
  const permissions = channel.permissionsFor(client.user);
  const missing = permissions ? permissions.missing(BOT_PERMISSIONS) : new PermissionsBitField(BOT_PERMISSIONS).toArray();
  if (missing.length > 0 || !channel.isSendable()) {
    throw new DiscordSetupError(`the bot is missing ${missing.join(", ") || "send access"} in #${channel.name}; give its role those permissions there`);
  }
}

/** Discord refused a privileged intent (gateway close 4014): it isn't switched on in the Developer Portal. */
export class DisallowedIntentsError extends Error {
  name = "DisallowedIntentsError";
}

/**
 * Log in and wait until the client is ready. The Guilds intent only (spec: Bot), plus GuildPresences
 * for match recaps when asked (Match Recap Spec: Discord setup). A refused privileged intent doesn't
 * make login() fail: the shard just disconnects and "ready" never comes, so that is raced here.
 */
export async function startDiscord(token: string, options: { presences?: boolean } = {}): Promise<Client<true>> {
  const intents = [GatewayIntentBits.Guilds, ...(options.presences ? [GatewayIntentBits.GuildPresences] : [])];
  const client = new Client({ intents });
  const ready = new Promise<Client<true>>((resolve, reject) => {
    client.once(Events.ClientReady, resolve);
    client.on(Events.ShardDisconnect, (event) => {
      if (event.code === 4014) {
        reject(new DisallowedIntentsError("Discord refused the Presence Intent: turn it on in the Developer Portal under Bot -> Privileged Gateway Intents"));
      }
    });
  });
  try {
    await client.login(token);
    return await ready;
  } catch (err) {
    await client.destroy();
    throw err;
  }
}

/** Posting and editing in one channel, for match recaps (they're edited when a late RR arrives). */
export function createChannelPoster(client: Client, channelId: string) {
  async function channel() {
    const found = await client.channels.fetch(channelId);
    if (!found?.isSendable() || !("messages" in found)) throw new Error(`Discord channel ${channelId} was not found, or the bot cannot send messages there`);
    return found;
  }
  return {
    async post(message: DiscordMessage): Promise<string> {
      return (await (await channel()).send(message)).id;
    },
    async edit(messageId: string, message: DiscordMessage): Promise<void> {
      // With new files, replace the old attachments instead of adding to them.
      await (await channel()).messages.edit(messageId, message.files ? { ...message, attachments: [] } : message);
    },
  };
}

/**
 * The previews that follow a shop post: each skin's name, then its Riot preview video URL on its own
 * line. A bot can't put a video inside an embed, but Discord turns a bare video link into a player.
 * Null when no skin in the shop has a video.
 */
export function previewMessage(snapshot: ShopSnapshot, label = "fully upgraded"): DiscordMessage | null {
  const lines = snapshot.offers.flatMap((o) => (o.links?.preview ? [`${escapeMarkdown(o.name)} (${label})`, o.links.preview] : []));
  return lines.length > 0 ? { content: lines.join("\n"), embeds: [], allowedMentions: { parse: [] } } : null;
}

/** Discord's error code when a user doesn't accept DMs from the bot. */
export const CANNOT_DM = 50007;

export const DM_BLOCKED_NOTE =
  "I tried to send you a private message (a wishlist hit, or a note about your link), but your Discord settings block DMs from this server's members. Allow them in this server's Privacy Settings.";

/**
 * One person's notifier, the owner's or a member's (spec: Schedule & notifications; Accounts).
 *
 * - Their shop is posted in the channel and pings them: everyone's shop is public.
 * - Wishlist hits go to them by DM, before the shop: a wishlist is private.
 * - Alerts go to the channel for the owner (cookie, Cloudflare, dead-man), by DM for a member.
 *
 * If someone blocks DMs, one note in the channel (once per process) asks them to allow them. It
 * never names a skin, and the shop is still posted.
 */
export function createPersonNotifier(
  client: Client,
  channelId: string,
  userId: string,
  alerts: "channel" | "dm",
  /** Their current Riot ID, read at send time so a renamed account shows its new name. */
  riotName: () => string | null = () => null,
): Notifier {
  let noteSent = false;

  async function channel() {
    const found = await client.channels.fetch(channelId);
    if (!found?.isSendable()) throw new Error(`Discord channel ${channelId} was not found, or the bot cannot send messages there`);
    return found;
  }

  /** DMs the person. Returns false if they block DMs (after leaving the note); throws on other errors. */
  async function dm(message: DiscordMessage): Promise<boolean> {
    try {
      const user = await client.users.fetch(userId);
      await user.send(message);
      return true;
    } catch (err) {
      if ((err as { code?: number }).code !== CANNOT_DM) throw err;
      if (!noteSent) {
        await (await channel()).send(alertMessage(DM_BLOCKED_NOTE, userId));
        noteSent = true;
      }
      return false;
    }
  }

  return {
    async sendShop(snapshot, wishlistHits) {
      // The private hit first: if the public post fails and is retried, a repeated DM is the lesser harm.
      if (wishlistHits.length > 0) await dm(wishlistMessage(wishlistHits, userId));
      const target = await channel();
      await target.send(shopMessage(snapshot, { userId, ping: true, riotName: riotName() }));
      // Best-effort: the shop is already posted, and a failure here must not make the caller post it again.
      const previews = previewMessage(snapshot);
      if (previews) await target.send(previews).catch((err: unknown) => log.warn("could not post the preview videos", { error: err }));
    },
    async sendAlert(text) {
      if (alerts === "channel") {
        await (await channel()).send(alertMessage(text, userId));
        return;
      }
      if (!(await dm({ content: text, embeds: [], allowedMentions: { parse: [] } }))) throw new Error("could not DM the alert: they block DMs");
    },
  };
}
