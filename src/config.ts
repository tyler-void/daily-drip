// Environment variables (spec: Storage & secrets). The Riot cookie is not one of them.

import { z } from "zod";

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord ID (17-20 digits)");

const schema = z.object({
  DISCORD_TOKEN: z.string().min(50, "looks too short for a bot token"),
  DISCORD_GUILD_ID: snowflake,
  DISCORD_CHANNEL_ID: snowflake,
  DISCORD_OWNER_ID: snowflake,
  RIOT_COOKIE_FILE: z.string().default("config/riot-cookie"),
  RIOT_SHARD: z.string().regex(/^[a-z]+$/, "lowercase letters only, e.g. ap").optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HEALTHCHECK_URL: z.url().optional(),
  // HenrikDev key for recaps of followed friends (Match Recap Spec). Without it, only the linked tier.
  HENRIK_API_KEY: z.string().min(10, "looks too short for a HenrikDev key").optional(),
  // Seals members' refresh tokens (src/secretbox.ts). Without it, /link is off and only the owner is served.
  TOKEN_KEY: z
    .string()
    .refine((v) => Buffer.from(v.trim(), "base64").length === 32, "must be 32 random bytes, base64 (openssl rand -base64 32)")
    .optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // .env.example ships empty values; treat empty as unset so defaults apply.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const result = schema.safeParse(present);
  if (!result.success) {
    // Issue messages name the variable and the rule, never the value.
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return result.data;
}
