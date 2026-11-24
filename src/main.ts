// Entry point: the Discord bot plus the scheduler.
// Runs once at start, then after every shop reset; answers /shop and /wishlist in between.

import { ensureOwner } from "./accounts.ts";
import { loadCatalog, storeSkins } from "./catalog.ts";
import { listenForCommands, registerCommands } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { createHttp } from "./http.ts";
import { createLock } from "./lock.ts";
import { addSecret, log } from "./log.ts";
import { checkDiscordSetup, createDiscordNotifier, DiscordSetupError, startDiscord } from "./notify/discord.ts";
import { postShop } from "./post.ts";
import { createScheduler } from "./scheduler.ts";
import { fetchShop, type ShopDeps } from "./shop.ts";
import { loadState, saveState } from "./state.ts";
import { ensureWishlist, wishlistPath } from "./wishlist.ts";

const config = loadConfig();
addSecret(config.DISCORD_TOKEN);
addSecret(config.HEALTHCHECK_URL); // its path is the check's secret key

const state = await loadState();
if (await ensureWishlist(state, wishlistPath(config.RIOT_COOKIE_FILE))) await saveState(state);
const withLock = createLock();
const save = (s: typeof state) => saveState(s);

// Store skins for /wishlist autocomplete; reloaded after each run, since a run may refresh the catalog.
let skinList = storeSkins(await loadCatalog());
const reloadSkinList = async () => {
  skinList = storeSkins(await loadCatalog());
};

const shopDeps: ShopDeps = {
  http: createHttp(),
  state,
  save,
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

// The owner is always in the account registry. The username lookup is best-effort.
const ownerUser = await client.users.fetch(config.DISCORD_OWNER_ID).catch(() => null);
if (ensureOwner(state.accounts, { discordUserId: config.DISCORD_OWNER_ID, discordUsername: ownerUser?.username ?? "", puuid: state.puuid })) {
  await saveState(state);
}

const notifier = createDiscordNotifier(client, config.DISCORD_CHANNEL_ID, config.DISCORD_OWNER_ID);

listenForCommands(client, {
  ownerId: config.DISCORD_OWNER_ID,
  cookieFile: config.RIOT_COOKIE_FILE,
  currentSnapshot: () => state.snapshot,
  runShop: () =>
    withLock(async () => {
      const snapshot = await fetchShop(shopDeps);
      await reloadSkinList();
      return snapshot;
    }),
  getWishlist: () => state.wishlist ?? [],
  setWishlist: (entries) =>
    withLock(async () => {
      state.wishlist = entries;
      await saveState(state);
    }),
  storeSkins: () => skinList,
});

const healthcheckUrl = config.HEALTHCHECK_URL;
const scheduler = createScheduler({
  state,
  save,
  run: () => postShop({ state, save, withLock, fetchShop: () => fetchShop(shopDeps), notifier, afterFetch: reloadSkinList }),
  notifier,
  cookieFile: config.RIOT_COOKIE_FILE,
  heartbeat: healthcheckUrl
    ? async () => {
        const res = await fetch(healthcheckUrl, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`healthcheck answered ${res.status}`);
      }
    : undefined,
});
scheduler.start();
log.info("running; press Ctrl+C to stop");

// Docker stops containers with SIGTERM; close the gateway connection cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info(`${signal}: shutting down`);
    scheduler.stop();
    void client.destroy().finally(() => process.exit(0));
  });
}
