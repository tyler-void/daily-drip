// /help: one embed on how to use the bot, listing only what this bot has switched on. Private by
// default; `share: true` posts it in the channel, e.g. to tell friends what the bot does.

import { type APIEmbed, SlashCommandBuilder } from "discord.js";

export const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("How to use daily-drip")
  .addBooleanOption((o) => o.setName("share").setDescription("Post it in the channel for everyone (default: only you see it)"));

export interface HelpInfo {
  /** Members can /link their own Riot account. */
  linking: boolean;
  /** Match recaps are on. */
  recaps: boolean;
  shopChannelId: string;
  recapChannelId: string;
}

const ACCENT = 0xcba6f7; // Enhalation accent (Mocha mauve)

/** The next daily shop reset, 00:00 UTC, as a Discord timestamp: each reader sees their own time. */
export function nextReset(now: number): string {
  const d = new Date(now);
  const reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000;
  return `<t:${reset}:t>`;
}

export function helpEmbed(info: HelpInfo, opts: { isOwner: boolean; shared: boolean; now: number }): APIEmbed {
  const fields: APIEmbed["fields"] = [];

  if (info.linking) {
    fields.push({
      name: "Get started",
      value: [
        "`/link` · connect your Riot account through Riot's own sign-in page. Your shop is then posted every day and pings you.",
        "`/unlink` · disconnect; the bot deletes what it holds about your account.",
      ].join("\n"),
    });
  }

  fields.push({
    name: "Shop",
    value: [
      `Every linked shop is posted in <#${info.shopChannelId}> right after the daily reset (${nextReset(opts.now)} your time), with its owner pinged.`,
      "`/shop` · your shop right now.",
      "`/preview skin: level:` · any store skin's video; leave `level` empty for fully upgraded.",
    ].join("\n"),
  });

  fields.push({
    name: "Wishlist · private",
    value: [
      "`/wishlist add weapon: skin:` · get a DM when it's in your shop. Pick **Any weapon** and type part of a name to match a whole line (\"Reaver\").",
      "`/wishlist list` · your entries, and which are in today's shop.",
      "`/wishlist remove entry:` · `/wishlist clear`",
    ].join("\n"),
  });

  if (info.recaps) {
    fields.push({
      name: "Match recaps",
      value: [
        `A recap card in <#${info.recapChannelId}> after each of your matches, pinging everyone on the list who played.`,
        "`/recap on` · `/recap off` · recaps for your linked account.",
        "`/recap join riot_id:` · not linked? Follow your Riot ID instead. `/recap leave` to stop.",
        "`/recap show player: match:` · a recap of any recent match, anyone's: pick someone, type a Riot ID (Name#TAG) or a Discord name. `match` 1 is the latest, up to 10. Pings nobody.",
        "`/recap trigger mode:` · `presence` while Discord shows you playing; `poll` every 20 min if you hide your activity.",
        "`/recap list` · who gets recaps.",
      ].join("\n"),
    });
  }

  if (opts.isOwner && !opts.shared && info.recaps) {
    fields.push({ name: "Owner only", value: "`/recap remove user:` · remove someone's recaps." });
  }

  return {
    title: "daily-drip · how to use it",
    color: ACCENT,
    description: "Your daily Valorant shop, wishlist pings, and match recaps.",
    fields,
    footer: { text: opts.shared ? "/help for this any time" : "Only you can see this · /help share:True posts it for everyone" },
  };
}
