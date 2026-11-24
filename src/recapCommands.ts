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
//   /recap show player: match:   a recap of anyone's recent match, on demand (1 = latest); the
//                                player autocompletes from people the bot knows, or is a Riot ID
//
// Replies are private except /recap list. A join is announced in the channel.

import { ActionRowBuilder, type APIEmbed, ButtonBuilder, ButtonStyle, type Client, escapeMarkdown, Events, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { CatalogNames } from "./catalog.ts";
import type { Henrik, HenrikAccount } from "./henrik.ts";
import { track } from "./inflight.ts";
import { log, redact } from "./log.ts";
import { LoginDeadError } from "./riot/login.ts";
import { type RecapInput, recapMessage, withCard } from "./notify/recapMessage.ts";
import { type LookupDeps, MAX_MATCH_NUMBER, nthMatch, type Person, playerChoices, resolvePlayer } from "./recapLookup.ts";
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
      .setName("show")
      .setDescription("Recap of a recent match: yours, or anyone's")
      .addStringOption((o) => o.setName("player").setDescription("Someone on the bot, a Discord username, or a Riot ID (Name#TAG); empty = you").setAutocomplete(true).setMaxLength(100))
      .addIntegerOption((o) => o.setName("match").setDescription(`1 = latest, 2 = the one before, up to ${MAX_MATCH_NUMBER}`).setMinValue(1).setMaxValue(MAX_MATCH_NUMBER)),
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
  /** Everyone the bot knows (linked and followed), for /recap show. */
  people: () => Person[];
  /** How /recap show fetches matches; null while recaps can't fetch anything. */
  lookup: LookupDeps;
  names: () => CatalogNames | null;
  /** Draws the recap card; null or a failure means the text recap. */
  card?: (input: RecapInput) => Promise<Uint8Array | null>;
  now?: () => number;
}

export const JOIN_EXPLAINER =
  "**Before you join:** after each of your competitive, unrated and swiftplay matches, the bot posts a recap **in this server's channel**, for everyone to see: your result, agent, K/D/A, ACS, HS%, ADR and RR change, and the match scoreboard. It reads your public match data through HenrikDev; it never signs in as you. `/recap leave` stops it and deletes your entry.";

type Reply = { content: string; flags?: number; components?: ActionRowBuilder<ButtonBuilder>[]; embeds?: APIEmbed[]; allowedMentions?: { parse: [] } | { users: string[] }; files?: { attachment: Buffer; name: string }[] };

export interface RecapInteraction {
  user: { id: string; username: string };
  options: { getSubcommand(): string; getString(name: string): string | null; getUser(name: string): { id: string; username: string } | null; getInteger(name: string): number | null };
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
      case "show": {
        // Public, like /shop; fetching takes longer than Discord's 3 s.
        await i.deferReply();
        const n = i.options.getInteger("match") ?? 1;
        try {
          const people = deps.people();
          const target = await resolvePlayer(i.options.getString("player"), id, people, deps.henrik);
          if (!target.ok) {
            await i.editReply({ content: target.reason, allowedMentions: { parse: [] } });
            return;
          }
          const found = await nthMatch(target.value, n, deps.lookup);
          if (!found.ok) {
            await i.editReply({ content: found.reason, allowedMentions: { parse: [] } });
            return;
          }
          const { recap, puuid, rr } = found.value;
          // The asked-for player, plus everyone else on the roster who was in that match.
          const tracked = [...new Set([puuid, ...recap.players.filter((p) => roster.active(r).some((e) => e.puuid === p.puuid)).map((p) => p.puuid)])];
          const discordIds = Object.fromEntries(people.filter((p) => recap.players.some((x) => x.puuid === p.puuid)).map((p) => [p.puuid, p.discordUserId]));
          const riotNames = Object.fromEntries(people.filter((p) => p.riotName && recap.players.some((x) => x.puuid === p.puuid)).map((p) => [p.puuid, p.riotName as string]));
          const input = { recap, tracked, rr, names: deps.names(), discordIds, riotNames };
          const png = deps.card ? await deps.card(input).catch(() => null) : null;
          const message = withCard(recapMessage(input), png);
          const who = target.value.kind === "person" ? (target.value.person.riotName ?? target.value.person.discordUsername ?? "their") : `${target.value.account.name}#${target.value.account.tag}`;
          const which = n === 1 ? "latest match" : `match ${n} back`;
          // On demand: mentions show names but ping nobody.
          await i.editReply({ ...message, content: `**Recap** · ${escapeMarkdown(who)}'s ${which}`, allowedMentions: { parse: [] } });
        } catch (err) {
          log.warn("/recap show failed", { error: err });
          const content =
            err instanceof LoginDeadError
              ? "Their Riot sign-in has run out, so the bot can't read their matches. They can `/link` again."
              : redact(`Couldn't fetch that match: ${err instanceof Error ? err.message : String(err)}`);
          await i.editReply({ content, allowedMentions: { parse: [] } });
        }
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

  /** Autocomplete for /recap show's player: people the bot knows, and a typed Riot ID. */
  async function autocomplete(a: { options: { getFocused(full: true): { name: string; value: string | number } }; respond(choices: { name: string; value: string }[]): Promise<unknown> }): Promise<void> {
    const focused = a.options.getFocused(true);
    await a.respond(focused.name === "player" ? playerChoices(deps.people(), String(focused.value)) : []);
  }

  return { command, button, autocomplete };
}

export function listenForRecapCommands(client: Client, handlers: ReturnType<typeof createRecapCommands>): void {
  // Tracked, so a shutdown waits for commands still being answered (src/inflight.ts).
  client.on(Events.InteractionCreate, (interaction) =>
    void track(async () => {
    try {
      if (interaction.isAutocomplete() && interaction.commandName === "recap") await handlers.autocomplete(interaction);
      else if (interaction.isChatInputCommand() && interaction.commandName === "recap") await handlers.command(interaction);
      else if (interaction.isButton() && (interaction.customId === JOIN_YES || interaction.customId === JOIN_NO)) await handlers.button(interaction);
    } catch (err) {
      log.error("recap command failed", { error: err });
    }
    }),
  );
}
