// Discord: the bot client, the message layouts and the Notifier (spec: Messages, Bot).

import {
  type APIEmbed,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  type MessageMentionOptions,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { ShopOffer, ShopSnapshot } from "../shop.ts";
import type { Notifier } from "./notifier.ts";

export interface DiscordMessage {
  content: string;
  embeds: APIEmbed[];
  allowedMentions: MessageMentionOptions;
}

const vp = (amount: number) => `${new Intl.NumberFormat("en-US").format(amount)} VP`;

/** One message, one embed per skin; the text is a live countdown to the reset. */
export function shopMessage(snapshot: ShopSnapshot): DiscordMessage {
  const resetsAt = Math.floor(Date.parse(snapshot.expiresAt) / 1000);
  const embeds = snapshot.offers.map((offer) => {
    const embed = new EmbedBuilder().setTitle(offer.name).setDescription(offer.vp !== null ? `**${vp(offer.vp)}**` : "Price unknown");
    if (offer.iconUrl) embed.setImage(offer.iconUrl);
    const color = offer.tier ? Number.parseInt(offer.tier.color, 16) : Number.NaN;
    if (offer.tier && Number.isFinite(color)) embed.setColor(color).setFooter({ text: offer.tier.name });
    return embed.toJSON();
  });
  // <t:…:R> renders as "in 20 hours" in each viewer's own time zone, and keeps counting.
  return { content: `**Daily shop** · resets <t:${resetsAt}:R>`, embeds, allowedMentions: { parse: [] } };
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

/** Log in with the Guilds intent only (spec: Bot) and wait until the client is ready. */
export async function startDiscord(token: string): Promise<Client<true>> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const ready = new Promise<Client<true>>((resolve) => client.once(Events.ClientReady, resolve));
  await client.login(token);
  return ready;
}

/** Discord's error code when a user doesn't accept DMs from the bot. */
const CANNOT_DM = 50007;

/**
 * A member's notifier: their shop, wishlist hits and alerts go to them by DM, since a member's shop
 * is their own. If they don't accept DMs, one short note in the channel tells them how to fix it;
 * the shop itself is never posted there. The note is sent at most once per process.
 */
export function createMemberNotifier(client: Client, userId: string, fallbackChannelId: string): Notifier {
  let noteSent = false;
  async function dm(message: DiscordMessage): Promise<void> {
    try {
      const user = await client.users.fetch(userId);
      await user.send(message);
    } catch (err) {
      if ((err as { code?: number }).code !== CANNOT_DM) throw err;
      if (!noteSent) {
        const channel = await client.channels.fetch(fallbackChannelId);
        if (channel?.isSendable()) {
          await channel.send(
            alertMessage("I can't send you your daily shop: your Discord settings block DMs from this server's members. Allow them under Privacy Settings for this server, then use `/shop`.", userId),
          );
          noteSent = true;
        }
      }
      throw err;
    }
  }
  return {
    async sendShop(snapshot, wishlistHits) {
      if (wishlistHits.length > 0) await dm(wishlistMessage(wishlistHits, userId));
      await dm(shopMessage(snapshot));
    },
    async sendAlert(text) {
      await dm({ content: text, embeds: [], allowedMentions: { parse: [] } });
    },
  };
}

export function createDiscordNotifier(client: Client, channelId: string, ownerId: string): Notifier {
  async function channel() {
    const found = await client.channels.fetch(channelId);
    if (!found?.isSendable()) throw new Error(`Discord channel ${channelId} was not found, or the bot cannot send messages there`);
    return found;
  }
  return {
    async sendShop(snapshot, wishlistHits) {
      const target = await channel();
      if (wishlistHits.length > 0) await target.send(wishlistMessage(wishlistHits, ownerId));
      await target.send(shopMessage(snapshot));
    },
    async sendAlert(text) {
      await (await channel()).send(alertMessage(text, ownerId));
    },
  };
}
