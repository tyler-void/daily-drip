// Slash commands (spec: Bot). /shop is owner-only and answers from the cached snapshot
// while it has not expired; otherwise it starts a run under the run lock.

import { type Client, Events, MessageFlags, SlashCommandBuilder } from "discord.js";
import { log, redact } from "./log.ts";
import { cookieDeadText, type DiscordMessage, shopMessage } from "./notify/discord.ts";
import { CookieDeadError } from "./riot/auth.ts";
import type { ShopSnapshot } from "./shop.ts";

export const shopCommand = new SlashCommandBuilder().setName("shop").setDescription("Show today's Valorant shop");

/** Guild commands show up at once, unlike global ones. */
export async function registerCommands(client: Client<true>, guildId: string): Promise<void> {
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([shopCommand.toJSON()]);
}

/** The parts of a slash-command interaction the handler uses, so tests can pass a fake. */
export interface ShopInteraction {
  user: { id: string };
  reply(options: Partial<DiscordMessage> & { flags?: number }): Promise<unknown>;
  deferReply(): Promise<unknown>;
  editReply(options: DiscordMessage): Promise<unknown>;
}

export interface ShopCommandDeps {
  ownerId: string;
  cookieFile: string;
  currentSnapshot(): ShopSnapshot | null;
  /** One run under the run lock. */
  runShop(): Promise<ShopSnapshot>;
  now?: () => number;
}

export async function handleShopCommand(interaction: ShopInteraction, deps: ShopCommandDeps): Promise<void> {
  if (interaction.user.id !== deps.ownerId) {
    await interaction.reply({ content: "Sorry, this bot only answers its owner.", flags: MessageFlags.Ephemeral });
    return;
  }
  const cached = deps.currentSnapshot();
  if (cached && Date.parse(cached.expiresAt) > (deps.now?.() ?? Date.now())) {
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
    await interaction.editReply({ content: text, embeds: [], allowedMentions: { parse: [] } });
  }
}

export function listenForCommands(client: Client, deps: ShopCommandDeps): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "shop") return;
    try {
      await handleShopCommand(interaction, deps);
    } catch (err) {
      log.error("/shop failed", { error: err });
    }
  });
}
