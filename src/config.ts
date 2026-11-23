// Environment variables (spec: Storage & secrets). The Riot cookie is not one of them.
// Discord variables join in build step 4.

import { z } from "zod";

const schema = z.object({
  RIOT_COOKIE_FILE: z.string().default("config/riot-cookie"),
  RIOT_SHARD: z.string().regex(/^[a-z]+$/, "lowercase letters only, e.g. ap").optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HEALTHCHECK_URL: z.url().optional(),
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
