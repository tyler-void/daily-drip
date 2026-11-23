import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const discord = {
  DISCORD_TOKEN: `${"M".repeat(26)}.${"G".repeat(6)}.${"x".repeat(38)}`,
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_CHANNEL_ID: "223456789012345678",
  DISCORD_OWNER_ID: "323456789012345678",
};

test("defaults apply, and empty values count as unset", () => {
  const config = loadConfig({ ...discord, RIOT_COOKIE_FILE: "", RIOT_SHARD: "  ", LOG_LEVEL: "" });
  expect(config.RIOT_COOKIE_FILE).toBe("config/riot-cookie");
  expect(config.RIOT_SHARD).toBeUndefined();
  expect(config.LOG_LEVEL).toBe("info");
});

test("missing Discord values are named, and no value is ever echoed", () => {
  expect(() => loadConfig({ DISCORD_TOKEN: "short-secret-value" })).toThrow(/DISCORD_GUILD_ID/);
  try {
    loadConfig({ ...discord, DISCORD_TOKEN: "short-secret-value" });
  } catch (err) {
    expect(String(err)).toContain("DISCORD_TOKEN");
    expect(String(err)).not.toContain("short-secret-value");
  }
});

test("Discord IDs must be snowflakes and the shard lowercase letters", () => {
  expect(() => loadConfig({ ...discord, DISCORD_OWNER_ID: "@me" })).toThrow(/DISCORD_OWNER_ID/);
  expect(() => loadConfig({ ...discord, RIOT_SHARD: "AP" })).toThrow(/RIOT_SHARD/);
  expect(loadConfig({ ...discord, RIOT_SHARD: "ap" }).RIOT_SHARD).toBe("ap");
});
