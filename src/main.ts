// Entry point: the Discord bot plus the schedulers.
// Runs once at start, then after every shop reset; answers /shop and /wishlist in between.
// With TOKEN_KEY set, members can /link their own Riot account (spec: Accounts).
// With RECAP=on, match recaps are posted after games (Match Recap Spec).

import { ensureOwner, type LinkedAccount, members, removeMember } from "./accounts.ts";
import { fetchGameVersion, loadCatalog, storeSkins } from "./catalog.ts";
import { listenForCommands, type MemberCommands, registerCommands } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { createHttp } from "./http.ts";
import { createLock } from "./lock.ts";
import { Events } from "discord.js";
import { addSecret, log } from "./log.ts";
import { createMemberScheduler } from "./memberScheduler.ts";
import { createHenrik } from "./henrik.ts";
import { canStartLink, completeLink, fetchMemberShop, linkDeadText, type MemberDeps, memberSession } from "./members.ts";
import { checkDiscordSetup, createChannelPoster, createPersonNotifier, DisallowedIntentsError, DiscordSetupError, startDiscord } from "./notify/discord.ts";
import type { Notifier } from "./notify/notifier.ts";
import { postShop } from "./post.ts";
import { createRecapCommands, listenForRecapCommands, recapCommand } from "./recapCommands.ts";
import type { Person } from "./recapLookup.ts";
import { createRecapPoller, type PdApi } from "./recapPoll.ts";
import { createRecapScheduler, isPlayingValorant } from "./recapScheduler.ts";
import { authenticate } from "./riot/auth.ts";
import { buildSignInUrl, LoginDeadError } from "./riot/login.ts";
import { fetchHistory, fetchMatchDetails, fetchRrUpdates } from "./riot/matches.ts";
import { active, ensureOwnerEntry, onUnlink, type RosterEntry, type Standing } from "./roster.ts";
import { createScheduler } from "./scheduler.ts";
import { importKey } from "./secretbox.ts";
import { createSessionCache } from "./sessions.ts";
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
  // Keep the owner's Riot ID current for their shop post; saved with the run's snapshot. Recaps reuse
  // this session instead of signing in again (each sign-in rotates the owner's cookie).
  onSession: (session) => {
    const owner = state.accounts[config.DISCORD_OWNER_ID];
    if (owner && session.riotName) owner.riotName = session.riotName;
    sessions.put(OWNER_SESSION, session);
  },
};
const sessions = createSessionCache();
const OWNER_SESSION = "owner";

// Members (spec: Accounts) only with TOKEN_KEY, which seals their refresh tokens at rest.
if (config.TOKEN_KEY) addSecret(config.TOKEN_KEY);
const memberDeps: MemberDeps | null = config.TOKEN_KEY
  ? { http: shopDeps.http, key: await importKey(config.TOKEN_KEY), save: () => saveState(state) }
  : null;

// Recaps need the Presence Intent. If Discord refuses it, start as before, without recaps.
let recapOn = config.RECAP === "on";
const client = await startDiscord(config.DISCORD_TOKEN, { presences: recapOn })
  .catch(async (err: unknown) => {
    if (!(err instanceof DisallowedIntentsError)) throw err;
    log.error(`${err.message}. Starting without match recaps.`);
    recapOn = false;
    return startDiscord(config.DISCORD_TOKEN);
  })
  .catch((err: unknown) => {
    // discord.js says "An invalid token was provided." without echoing the token.
    log.error(`could not log in to Discord: ${err instanceof Error ? err.message : String(err)}. Check DISCORD_TOKEN.`);
    process.exit(1);
  });
log.info("connected to Discord", { as: client.user.tag });
try {
  await checkDiscordSetup(client, config.DISCORD_GUILD_ID, config.DISCORD_CHANNEL_ID);
  await registerCommands(client, config.DISCORD_GUILD_ID, memberDeps !== null, recapOn ? [recapCommand] : []);
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
            // Their recap entry goes with them, and so does any cached session (Match Recap Spec).
            onUnlink(state.recap.roster, userId);
            sessions.drop(userId);
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
  catalog: () => catalog,
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

// ---------- match recaps (Match Recap Spec) ----------

const recapScheduler = recapOn ? startRecaps() : null;

function startRecaps() {
  const http = shopDeps.http;
  const henrik = config.HENRIK_API_KEY ? createHenrik({ http, key: config.HENRIK_API_KEY }) : null;
  const poster = createChannelPoster(client, config.RECAP_CHANNEL_ID ?? config.DISCORD_CHANNEL_ID);
  const roster = state.recap.roster;

  // The owner is on the roster by default (off stays off once they turn it off).
  if (ensureOwnerEntry(roster, { discordUserId: config.DISCORD_OWNER_ID, puuid: state.puuid, riotName: riotNameOf(config.DISCORD_OWNER_ID) })) void saveState(state);

  // X-Riot-ClientVersion from the catalog (refreshed by the shop), else asked once an hour.
  let fetchedVersion: { value: string; at: number } | null = null;
  const clientVersion = async () => {
    if (catalog?.gameVersion.riotClientVersion) return catalog.gameVersion.riotClientVersion;
    if (!fetchedVersion || Date.now() - fetchedVersion.at > 3_600_000) fetchedVersion = { value: (await fetchGameVersion(http)).riotClientVersion, at: Date.now() };
    return fetchedVersion.value;
  };

  const keyOf = (entry: RosterEntry) => (entry.discordUserId === config.DISCORD_OWNER_ID ? OWNER_SESSION : entry.discordUserId);
  // A session per linked person, minted under the run lock so it never overlaps a shop run's sign-in.
  const pd: PdApi = {
    session: (entry) =>
      sessions.get(keyOf(entry), () =>
        withLock(async () => {
          if (entry.discordUserId === config.DISCORD_OWNER_ID) return authenticate(shopDeps);
          const account = state.accounts[entry.discordUserId];
          if (!memberDeps || !account?.member) throw new LoginDeadError("not linked any more");
          return memberSession(account, memberDeps);
        }),
      ),
    dropSession: (entry) => sessions.drop(keyOf(entry)),
    history: async (s, count) => fetchHistory(http, s, await clientVersion(), s.puuid, count),
    details: async (s, matchId) => fetchMatchDetails(http, s, await clientVersion(), matchId),
    rr: async (s) => fetchRrUpdates(http, s, await clientVersion()),
  };

  const poller = createRecapPoller({
    recap: state.recap,
    save: () => saveState(state),
    queues: config.RECAP_QUEUES.split(","),
    names: () => catalog?.names ?? null,
    pd,
    henrik,
    post: poster.post,
    edit: poster.edit,
  });
  const scheduler = createRecapScheduler({
    entries: () => active(state.recap.roster),
    sourceOf: (entry) => (entry.tier === "followed" ? "henrik" : "pd"),
    poll: poller.poll,
  });

  /** Everyone the bot knows, for /recap show: linked people (own session), then followed friends. */
  const people = (): Person[] => {
    const out: Person[] = [];
    for (const a of Object.values(state.accounts)) {
      const puuid = a.role === "owner" ? (a.puuid ?? state.puuid) : a.member ? a.puuid : null;
      if (puuid) out.push({ discordUserId: a.discordUserId, discordUsername: a.discordUsername || null, riotName: a.riotName, puuid, linked: true, region: null });
    }
    for (const e of Object.values(state.recap.roster)) {
      if (e.tier !== "followed" || out.some((p) => p.puuid === e.puuid)) continue;
      out.push({ discordUserId: e.discordUserId, discordUsername: client.users.cache.get(e.discordUserId)?.username ?? null, riotName: e.riotName, puuid: e.puuid, linked: false, region: e.region });
    }
    return out;
  };

  const standing = (userId: string): Standing => {
    if (userId === config.DISCORD_OWNER_ID) return { kind: "owner", puuid: state.puuid };
    const account = state.accounts[userId];
    return account?.role === "member" && account.member ? { kind: "member", puuid: account.puuid } : { kind: "none" };
  };
  listenForRecapCommands(
    client,
    createRecapCommands({
      ownerId: config.DISCORD_OWNER_ID,
      roster: () => state.recap.roster,
      save: () => withLock(() => saveState(state)),
      standing,
      riotNameOf,
      henrik,
      announce: async (text) => void (await poster.post({ content: text, embeds: [], allowedMentions: { parse: [] } })),
      people,
      lookup: { pd, henrik },
      names: () => catalog?.names ?? null,
    }),
  );

  // Presence decides when to poll. Seed it from who is playing right now, then follow the updates.
  const guild = client.guilds.cache.get(config.DISCORD_GUILD_ID);
  for (const presence of guild?.presences.cache.values() ?? []) scheduler.presence(presence.userId, isPlayingValorant(presence.activities));
  client.on(Events.PresenceUpdate, (_old, presence) => {
    // Spike S1: what the owner's presence looks like over a real session (their own, nobody else's).
    if (presence.userId === config.DISCORD_OWNER_ID) {
      log.info("owner presence", { activities: presence.activities.map((a) => ({ name: a.name, type: a.type, applicationId: a.applicationId })) });
    }
    scheduler.presence(presence.userId, isPlayingValorant(presence.activities));
  });
  scheduler.start();
  return scheduler;
}

log.info("running; press Ctrl+C to stop", {
  linking: memberDeps ? "on" : "off (no TOKEN_KEY)",
  members: members(state.accounts).length,
  recaps: recapOn ? `on (${active(state.recap.roster).length} on the roster)` : "off",
});

// Docker stops containers with SIGTERM; close the gateway connection cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info(`${signal}: shutting down`);
    scheduler.stop();
    memberScheduler?.stop();
    recapScheduler?.stop();
    void client.destroy().finally(() => process.exit(0));
  });
}
