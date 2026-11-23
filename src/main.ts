// Entry point. Build step 4: the Discord bot. On start it runs once and posts the shop
// (skipped if this exact shop was already sent), then stays up to answer /shop.
// Step 5 adds the timers (next reset, retries, dead-man switch); step 6 the alerts.

import { listenForCommands, registerCommands } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { createHttp, NetworkError } from "./http.ts";
import { createLock } from "./lock.ts";
import { addSecret, log } from "./log.ts";
import { checkDiscordSetup, createDiscordNotifier, DiscordSetupError, startDiscord } from "./notify/discord.ts";
import { CloudflareBlockedError, CookieDeadError, RateLimitedError, UnexpectedResponseError } from "./riot/auth.ts";
import { BadClaimsError, MaintenanceError } from "./riot/store.ts";
import { fetchShop, type ShopDeps } from "./shop.ts";
import { loadState, saveState } from "./state.ts";
import { loadWishlist, matchWishlist, wishlistPath } from "./wishlist.ts";

const config = loadConfig();
addSecret(config.DISCORD_TOKEN);

const state = await loadState();
const withLock = createLock();
const shopDeps: ShopDeps = {
  http: createHttp(),
  state,
  save: (s) => saveState(s),
  cookieFile: config.RIOT_COOKIE_FILE,
  shardOverride: config.RIOT_SHARD,
};

const client = await startDiscord(config.DISCORD_TOKEN).catch((err: unknown) => {
  // discord.js says "An invalid token was provided." without echoing the token.
  log.error(`could not log in to Discord: ${err instanceof Error ? err.message : String(err)}. Check DISCORD_TOKEN.`);
  process.exit(1);
});
log.info("connected to Discord", { as: client.user.tag });
try {
  await checkDiscordSetup(client, config.DISCORD_GUILD_ID, config.DISCORD_CHANNEL_ID);
  await registerCommands(client, config.DISCORD_GUILD_ID);
} catch (err) {
  log.error(`Discord setup: ${err instanceof DiscordSetupError ? err.message : String(err)}`);
  await client.destroy();
  process.exit(1);
}
listenForCommands(client, {
  ownerId: config.DISCORD_OWNER_ID,
  cookieFile: config.RIOT_COOKIE_FILE,
  currentSnapshot: () => state.snapshot,
  runShop: () => withLock(() => fetchShop(shopDeps)),
});
const notifier = createDiscordNotifier(client, config.DISCORD_CHANNEL_ID, config.DISCORD_OWNER_ID);

/** One scheduled run: fetch, then post unless this exact shop was already sent. All of it under the run lock. */
async function postShop(): Promise<void> {
  await withLock(async () => {
    const snapshot = await fetchShop(shopDeps);
    if (snapshot.hash === state.lastSentHash) {
      log.info("this shop was already sent; nothing to post");
      return;
    }
    const hits = matchWishlist(snapshot.offers, await loadWishlist(wishlistPath(config.RIOT_COOKIE_FILE)));
    await notifier.sendShop(snapshot, hits);
    // Spec: lastSentHash is written only after Discord accepts the message.
    state.lastSentHash = snapshot.hash;
    await saveState(state);
    log.info("shop posted", { offers: snapshot.offers.map((o) => o.name), wishlistHits: hits.map((h) => h.name) });
  });
}

try {
  await postShop();
} catch (err) {
  if (err instanceof CookieDeadError) log.error(`cookie dead: ${err.message}. Put a fresh cookie header in ${config.RIOT_COOKIE_FILE}.`);
  else if (err instanceof CloudflareBlockedError) log.error(`blocked: ${err.message}. See the TLS fallback in the spec (Endpoints, TLS).`);
  else if (err instanceof MaintenanceError || err instanceof BadClaimsError || err instanceof RateLimitedError) log.error(err.message);
  else if (err instanceof NetworkError || err instanceof UnexpectedResponseError) log.error(`run failed: ${err.message}`);
  else log.error("run failed", { error: err });
}
log.info("listening for /shop; press Ctrl+C to stop");

// Docker stops containers with SIGTERM; close the gateway connection cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info(`${signal}: shutting down`);
    void client.destroy().finally(() => process.exit(0));
  });
}
