// Entry point: the Discord bot plus the schedulers.
// Runs once at start, then after every shop reset; answers /shop and /wishlist in between.
// With TOKEN_KEY set, members can /link their own Riot account (spec: Accounts).

import { ensureOwner, type LinkedAccount, members, removeMember } from "./accounts.ts";
import { loadCatalog, storeSkins } from "./catalog.ts";
import { listenForCommands, type MemberCommands, registerCommands } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { createHttp } from "./http.ts";
import { createLock } from "./lock.ts";
import { addSecret, log } from "./log.ts";
import { createMemberScheduler } from "./memberScheduler.ts";
import { canStartLink, completeLink, fetchMemberShop, linkDeadText, type MemberDeps } from "./members.ts";
import { checkDiscordSetup, createPersonNotifier, DiscordSetupError, startDiscord } from "./notify/discord.ts";
import type { Notifier } from "./notify/notifier.ts";
import { postShop } from "./post.ts";
import { buildSignInUrl } from "./riot/login.ts";
import { createScheduler } from "./scheduler.ts";
import { importKey } from "./secretbox.ts";
import { fetchShop, type ShopDeps, withLinks } from "./shop.ts";
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
// The catalog also fills in links on shops saved before links existed (withLinks).
let catalog = await loadCatalog();
let skinList = storeSkins(catalog);
const reloadSkinList = async () => {
  catalog = await loadCatalog();
  skinList = storeSkins(catalog);
};

const shopDeps: ShopDeps = {
  http: createHttp(),
  state,
  save,
  cookieFile: config.RIOT_COOKIE_FILE,
  shardOverride: config.RIOT_SHARD,
  // Keep the owner's Riot ID current for their shop post; saved with the run's snapshot.
  onSession: (session) => {
    const owner = state.accounts[config.DISCORD_OWNER_ID];
    if (owner && session.riotName) owner.riotName = session.riotName;
  },
};

// Members (spec: Accounts) only with TOKEN_KEY, which seals their refresh tokens at rest.
if (config.TOKEN_KEY) addSecret(config.TOKEN_KEY);
const memberDeps: MemberDeps | null = config.TOKEN_KEY
  ? { http: shopDeps.http, key: await importKey(config.TOKEN_KEY), save: () => saveState(state) }
  : null;

const client = await startDiscord(config.DISCORD_TOKEN).catch((err: unknown) => {
  // discord.js says "An invalid token was provided." without echoing the token.
  log.error(`could not log in to Discord: ${err instanceof Error ? err.message : String(err)}. Check DISCORD_TOKEN.`);
  process.exit(1);
});
log.info("connected to Discord", { as: client.user.tag });
try {
  await checkDiscordSetup(client, config.DISCORD_GUILD_ID, config.DISCORD_CHANNEL_ID);
  await registerCommands(client, config.DISCORD_GUILD_ID, memberDeps !== null);
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

// Everyone's shop goes in the channel with a ping; wishlist hits by DM. The owner's alerts stay in the channel.
const riotNameOf = (userId: string) => state.accounts[userId]?.riotName ?? null;
const notifier = createPersonNotifier(client, config.DISCORD_CHANNEL_ID, config.DISCORD_OWNER_ID, "channel", () => riotNameOf(config.DISCORD_OWNER_ID));

// One notifier per member, kept for the process, so the "allow DMs" note goes out once. A member's alerts go by DM.
const memberNotifiers = new Map<string, Notifier>();
const memberNotifier = (userId: string): Notifier => {
  let found = memberNotifiers.get(userId);
  if (!found) {
    found = createPersonNotifier(client, config.DISCORD_CHANNEL_ID, userId, "dm", () => riotNameOf(userId));
    memberNotifiers.set(userId, found);
  }
  return found;
};

/** The member's current entry, if they are still linked. Checked inside the lock, after any wait. */
function stillLinked(account: LinkedAccount): NonNullable<LinkedAccount["member"]> {
  const member = state.accounts[account.discordUserId] === account ? account.member : null;
  if (!member) throw new Error(`${account.discordUsername} unlinked before their run`);
  return member;
}

const memberCommands: MemberCommands | undefined = memberDeps
  ? {
      shopFor(userId) {
        const account = state.accounts[userId];
        if (account?.role !== "member" || !account.member) return null;
        return {
          currentSnapshot: () => withLinks(account.member?.snapshot ?? null, catalog),
          runShop: () =>
            withLock(async () => {
              stillLinked(account);
              const snapshot = await fetchMemberShop(account, memberDeps);
              await reloadSkinList();
              return snapshot;
            }),
          getWishlist: () => account.member?.wishlist ?? [],
          setWishlist: (entries) =>
            withLock(async () => {
              stillLinked(account).wishlist = entries;
              await saveState(state);
            }),
        };
      },
      startLink(userId) {
        const allowed = canStartLink(state.accounts, userId);
        return allowed.ok ? { ok: true, value: { url: buildSignInUrl() } } : allowed;
      },
      finishLink: (user, pasted) =>
        withLock(async () => {
          const linked = await completeLink(state.accounts, { discordUserId: user.id, discordUsername: user.username }, pasted, memberDeps);
          if (linked.ok) log.info("a member linked their Riot account", { member: linked.value.discordUsername });
          return linked.ok ? { ok: true, value: { riotName: linked.value.riotName } } : linked;
        }),
      unlink: (userId) =>
        withLock(async () => {
          const removed = removeMember(state.accounts, userId);
          if (removed.ok) {
            memberNotifiers.delete(userId);
            await saveState(state);
            log.info("a member unlinked", { member: removed.value.discordUsername });
          }
          return removed;
        }),
    }
  : undefined;

listenForCommands(client, {
  ownerId: config.DISCORD_OWNER_ID,
  cookieFile: config.RIOT_COOKIE_FILE,
  currentSnapshot: () => withLinks(state.snapshot, catalog),
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
  members: memberCommands,
  riotName: riotNameOf,
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

const memberScheduler = memberDeps
  ? createMemberScheduler({
      accounts: () => state.accounts,
      run: (account) =>
        postShop({
          state: account.member as NonNullable<LinkedAccount["member"]>,
          save: () => saveState(state),
          withLock,
          fetchShop: () => {
            stillLinked(account);
            return fetchMemberShop(account, memberDeps);
          },
          notifier: memberNotifier(account.discordUserId),
          afterFetch: reloadSkinList,
        }),
      notifyLinkDead: (account) => memberNotifier(account.discordUserId).sendAlert(linkDeadText()),
      save: () => saveState(state),
    })
  : null;
memberScheduler?.start();
log.info("running; press Ctrl+C to stop", {
  linking: memberDeps ? "on" : "off (no TOKEN_KEY)",
  members: members(state.accounts).length,
});

// Docker stops containers with SIGTERM; close the gateway connection cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info(`${signal}: shutting down`);
    scheduler.stop();
    memberScheduler?.stop();
    void client.destroy().finally(() => process.exit(0));
  });
}
