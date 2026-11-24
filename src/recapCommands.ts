// /recap (Match Recap Spec: Roster & consent). Everyone on the roster put themselves there; the
// owner can remove people but never add them.
//
//   /recap on | off              join or pause the linked tier (owner on by default, members off)
//   /recap join riot_id:         a server member who isn't linked follows their own Riot ID, after
//                                a private explanation and a Confirm button
//   /recap leave                 a followed member deletes their entry
//   /recap list                  the roster
//   /recap trigger mode:         presence (default) or poll, for people without activity status
//   /recap remove user:          owner only
//
// Replies are private except /recap list. A join is announced in the channel.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, escapeMarkdown, Events, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Henrik, HenrikAccount } from "./henrik.ts";
import { log, redact } from "./log.ts";
import * as roster from "./roster.ts";

export const JOIN_YES = "recap:join:yes";
export const JOIN_NO = "recap:join:no";
const PENDING_MS = 5 * 60_000;

export const recapCommand = new SlashCommandBuilder()
  .setName("recap")
  .setDescription("Match recaps posted in the channel after your games")
  .addSubcommand((s) => s.setName("on").setDescription("Turn recaps on for your linked Riot account"))
  .addSubcommand((s) => s.setName("off").setDescription("Stop recaps for you (you stay on the list; /recap on restores it)"))
  .addSubcommand((s) =>
    s
      .setName("join")
      .setDescription("Not linked? Follow your own Riot ID for recaps")
      .addStringOption((o) => o.setName("riot_id").setDescription("Your Riot ID, e.g. Name#TAG").setRequired(true).setMaxLength(40)),
  )
  .addSubcommand((s) => s.setName("leave").setDescription("Stop following your Riot ID and delete it from the list"))
  .addSubcommand((s) => s.setName("list").setDescription("Who gets match recaps"))
  .addSubcommand((s) =>
    s
      .setName("trigger")
      .setDescription("How the bot notices you played")
      .addStringOption((o) =>
        o
          .setName("mode")
          .setDescription("presence: while Discord shows you playing; poll: every 20 min, if you hide your activity")
          .setRequired(true)
          .addChoices({ name: "presence (default)", value: "presence" }, { name: "poll every 20 min", value: "poll" }),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("Owner only: remove someone's recaps")
      .addUserOption((o) => o.setName("user").setDescription("Whose recaps to remove").setRequired(true)),
  );

export interface RecapCommandDeps {
  ownerId: string;
  roster: () => roster.Roster;
  /** Saves under the run lock. */
  save: () => Promise<void>;
  /** The owner or a linked member (with their PUUID), or nobody. */
  standing: (userId: string) => roster.Standing;
  riotNameOf: (userId: string) => string | null;
  /** Null without HENRIK_API_KEY: /recap join is off. */
  henrik: Henrik | null;
  /** A short note in the recap channel; pings nobody. */
  announce: (text: string) => Promise<void>;
  now?: () => number;
}

export const JOIN_EXPLAINER =
  "**Before you join:** after each of your competitive, unrated and swiftplay matches, the bot posts a recap **in this server's channel**, for everyone to see: your result, agent, K/D/A, ACS, HS%, ADR and RR change, and the match scoreboard. It reads your public match data through HenrikDev; it never signs in as you. `/recap leave` stops it and deletes your entry.";

type Reply = { content: string; flags?: number; components?: ActionRowBuilder<ButtonBuilder>[]; allowedMentions?: { parse: [] } };

export interface RecapInteraction {
  user: { id: string; username: string };
  options: { getSubcommand(): string; getString(name: string): string | null; getUser(name: string): { id: string; username: string } | null };
  reply(options: Reply): Promise<unknown>;
  deferReply(options?: { flags?: number }): Promise<unknown>;
  editReply(options: Reply): Promise<unknown>;
}

export interface JoinButtonInteraction {
  user: { id: string; username: string };
  customId: string;
  update(options: Reply): Promise<unknown>;
  reply(options: Reply): Promise<unknown>;
}

export function createRecapCommands(deps: RecapCommandDeps) {
  const now = () => deps.now?.() ?? Date.now();
  /** User ID -> the account they asked to follow, until they confirm. */
  const pending = new Map<string, { account: HenrikAccount; at: number }>();
  const priv = (content: string): Reply => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  const nameOf = (e: roster.RosterEntry) => e.riotName ?? e.puuid.slice(0, 8);

  async function command(i: RecapInteraction): Promise<void> {
    const id = i.user.id;
    const r = deps.roster();
    switch (i.options.getSubcommand()) {
      case "on": {
        const result = roster.turnOn(r, id, deps.standing(id), deps.riotNameOf(id), new Date(now()));
        if (result.ok) await deps.save();
        await i.reply(priv(result.ok ? "Recaps are on: after your matches, a recap goes in the channel. `/recap off` pauses them." : result.reason));
        return;
      }
      case "off": {
        const result = roster.turnOff(r, id);
        if (result.ok) await deps.save();
        await i.reply(priv(result.ok ? "Recaps are off for you. `/recap on` turns them back on." : result.reason));
        return;
      }
      case "leave": {
        const result = roster.leave(r, id);
        if (result.ok) await deps.save();
        await i.reply(priv(result.ok ? "Done: your Riot ID is no longer followed, and the bot deleted your entry." : result.reason));
        return;
      }
      case "trigger": {
        const mode = i.options.getString("mode") === "poll" ? "poll" : "presence";
        const result = roster.setTrigger(r, id, mode);
        if (result.ok) await deps.save();
        await i.reply(priv(result.ok ? (mode === "poll" ? "The bot now checks for your matches every 20 minutes." : "The bot now checks for matches while Discord shows you playing VALORANT.") : result.reason));
        return;
      }
      case "list": {
        const entries = Object.values(r).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
        const lines = entries.map(
          (e) => `- <@${e.discordUserId}> ${escapeMarkdown(nameOf(e))} · ${e.tier}${e.enabled ? "" : " · off"}${e.trigger === "poll" ? " · polled" : ""}`,
        );
        await i.reply({ content: lines.length ? `**Match recaps** (${lines.length})\n${lines.join("\n")}` : "Nobody gets match recaps yet. `/recap on` (linked) or `/recap join` (not linked).", allowedMentions: { parse: [] } });
        return;
      }
      case "remove": {
        if (id !== deps.ownerId) {
          await i.reply(priv("Only the bot's owner can remove someone's recaps."));
          return;
        }
        const target = i.options.getUser("user");
        const result = target ? roster.remove(r, target.id) : { ok: false as const, reason: "Pick a user." };
        if (result.ok) await deps.save();
        await i.reply(priv(result.ok ? (result.value.deleted ? "Removed: their followed Riot ID is deleted." : "Their recaps are switched off; they can turn them back on.") : result.reason));
        return;
      }
      case "join": {
        if (!deps.henrik) {
          await i.reply(priv("Following a Riot ID isn't set up on this bot."));
          return;
        }
        const standing = deps.standing(id);
        if (standing.kind !== "none") {
          await i.reply(priv("Your Riot account is linked to the bot; use `/recap on` instead."));
          return;
        }
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        let account: HenrikAccount | null;
        try {
          account = await deps.henrik.account(i.options.getString("riot_id") ?? "");
        } catch (err) {
          await i.editReply(priv(redact(`Couldn't look that Riot ID up right now: ${err instanceof Error ? err.message : String(err)}. Try again later.`)));
          return;
        }
        if (!account) {
          await i.editReply(priv("No Riot account has that ID. Check the name and the tag after #."));
          return;
        }
        pending.set(id, { account, at: now() });
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(JOIN_YES).setStyle(ButtonStyle.Success).setLabel(`Yes, follow ${account.name}#${account.tag}`.slice(0, 80)),
          new ButtonBuilder().setCustomId(JOIN_NO).setStyle(ButtonStyle.Secondary).setLabel("Cancel"),
        );
        await i.editReply({ ...priv(JOIN_EXPLAINER), components: [row] });
        return;
      }
    }
  }

  async function button(b: JoinButtonInteraction): Promise<void> {
    const waiting = pending.get(b.user.id);
    pending.delete(b.user.id);
    if (b.customId === JOIN_NO) {
      await b.update({ ...priv("Cancelled; nothing was saved."), components: [] });
      return;
    }
    if (!waiting || now() - waiting.at > PENDING_MS) {
      await b.update({ ...priv("That request expired. Run `/recap join` again."), components: [] });
      return;
    }
    const { account } = waiting;
    const riotName = `${account.name}#${account.tag}`;
    const result = roster.join(deps.roster(), b.user.id, deps.standing(b.user.id), { puuid: account.puuid, riotName, region: account.region }, new Date(now()));
    if (!result.ok) {
      await b.update({ ...priv(result.reason), components: [] });
      return;
    }
    await deps.save();
    await b.update({ ...priv(`You're in: recaps for **${escapeMarkdown(riotName)}** will be posted in the channel. \`/recap leave\` stops them.`), components: [] });
    await deps.announce(`<@${b.user.id}> joined match recaps as **${escapeMarkdown(riotName)}**.`).catch((err: unknown) => log.warn("could not announce a recap join", { error: err }));
    log.info("a server member joined recaps", { member: b.user.username });
  }

  return { command, button };
}

export function listenForRecapCommands(client: Client, handlers: ReturnType<typeof createRecapCommands>): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === "recap") await handlers.command(interaction);
      else if (interaction.isButton() && (interaction.customId === JOIN_YES || interaction.customId === JOIN_NO)) await handlers.button(interaction);
    } catch (err) {
      log.error("recap command failed", { error: err });
    }
  });
}
