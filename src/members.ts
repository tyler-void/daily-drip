// Members' accounts (spec: Accounts): finishing a /link, and running a member's shop.
//
// A member links by signing in on Riot's own page and pasting back the localhost address their
// browser lands on (src/riot/login.ts). The bot keeps only the refresh token, sealed with TOKEN_KEY,
// on the member's registry entry. Each run refreshes it, stores the newest one at once, then reuses
// the owner's pipeline from the session onwards (completeSession, fetchSnapshot).

import { type AccountRegistry, addMember, findByPuuid, type LinkedAccount, MAX_MEMBERS, members, type Result, setRiotIdentity } from "./accounts.ts";
import type { Http } from "./http.ts";
import { completeSession, type Session } from "./riot/auth.ts";
import { exchangeCode, extractCode, LoginDeadError, refreshTokens } from "./riot/login.ts";
import { open, seal } from "./secretbox.ts";
import { fetchSnapshot, type ShopSnapshot } from "./shop.ts";

export interface MemberDeps {
  http: Http;
  /** TOKEN_KEY, imported (src/secretbox.ts). */
  key: CryptoKey;
  /** Persists the whole state. */
  save: () => Promise<void>;
  catalogFile?: string;
  now?: () => Date;
}

export const PASTE_HELP = "Copy the whole address your browser shows after you sign in: it starts with `http://localhost/redirect?` and contains `code=`.";

/** Before showing a sign-in link: is this Discord user allowed to link (or link again)? */
export function canStartLink(registry: AccountRegistry, discordUserId: string): Result<void> {
  const existing = registry[discordUserId];
  if (existing?.role === "owner") return { ok: false, reason: "You're the bot's owner; your account is set up on the server, not with `/link`." };
  if (!existing && members(registry).length >= MAX_MEMBERS) {
    return { ok: false, reason: `The bot already has ${MAX_MEMBERS} linked members, its limit.` };
  }
  return { ok: true, value: undefined };
}

/**
 * /link's last step. Trades the pasted code for tokens, finds out which Riot account they belong to,
 * and only then changes the registry: a Riot account already linked to someone else (the owner's
 * included) is refused. Linking again keeps the member's wishlist. Throws only on network or Riot
 * errors; a bad paste or a refused account is a `{ ok: false }` with a reason to show.
 */
export async function completeLink(
  registry: AccountRegistry,
  who: { discordUserId: string; discordUsername: string },
  pasted: string,
  deps: MemberDeps,
): Promise<Result<LinkedAccount>> {
  const allowed = canStartLink(registry, who.discordUserId);
  if (!allowed.ok) return allowed;
  const code = extractCode(pasted);
  if (!code) return { ok: false, reason: `That doesn't look like the right address. ${PASTE_HELP}` };

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(deps.http, code);
  } catch (err) {
    if (err instanceof LoginDeadError) {
      return { ok: false, reason: "That sign-in code was already used or has expired. Run `/link` again and paste the new address right away." };
    }
    throw err;
  }

  // Which Riot account is this? E2, E3 and E4 with an empty cache fill in the PUUID, shard and Riot ID.
  const cache = { puuid: null as string | null, shard: null as string | null };
  const { riotName } = await completeSession(deps.http, tokens, cache);
  const puuid = cache.puuid as string;
  const holder = findByPuuid(registry, puuid);
  if (holder && holder.discordUserId !== who.discordUserId) {
    return { ok: false, reason: "That Riot account is already linked to someone else in this bot." };
  }

  // Seal first, so a failure here can't leave a half-linked entry behind.
  const sealedRefreshToken = await seal(deps.key, tokens.refreshToken);

  let account = registry[who.discordUserId];
  if (!account) {
    const added = addMember(registry, who, deps.now?.() ?? new Date());
    if (!added.ok) return added;
    account = added.value;
  }
  // Decided before setRiotIdentity overwrites the PUUID: is this the Riot account linked before?
  const previous = account.member;
  const kept = previous !== null && account.puuid === puuid ? previous : null;
  if (who.discordUsername) account.discordUsername = who.discordUsername;
  const identity = setRiotIdentity(registry, who.discordUserId, { puuid, riotName });
  if (!identity.ok) return identity;

  account.member = {
    sealedRefreshToken,
    shard: cache.shard,
    // Another Riot account's shop and sent-hash no longer apply; the wishlist is the member's own.
    snapshot: kept?.snapshot ?? null,
    wishlist: previous?.wishlist ?? [],
    lastSentHash: kept?.lastSentHash ?? null,
    lastSuccessAt: kept?.lastSuccessAt ?? null,
    linkDeadNotified: false,
  };
  await deps.save();
  return { ok: true, value: account };
}

/**
 * One member's run: refresh -> session -> snapshot. Riot may rotate the refresh token on any use,
 * and only the newest one works, so a changed token is sealed and saved before anything else can
 * fail. Throws LoginDeadError when the member must link again; other errors are the owner's run's.
 */
export async function fetchMemberShop(account: LinkedAccount, deps: MemberDeps): Promise<ShopSnapshot> {
  const member = account.member;
  if (!member) throw new LoginDeadError(`${account.discordUsername} hasn't finished linking`);

  const session = async (): Promise<Session> => {
    const held = await open(deps.key, member.sealedRefreshToken);
    const tokens = await refreshTokens(deps.http, held);
    if (tokens.refreshToken !== held) {
      member.sealedRefreshToken = await seal(deps.key, tokens.refreshToken);
      await deps.save();
    }
    const cache = { puuid: account.puuid, shard: member.shard };
    const { session, cacheChanged } = await completeSession(deps.http, tokens, cache);
    if (cacheChanged) {
      account.puuid = cache.puuid;
      member.shard = cache.shard;
      await deps.save();
    }
    return session;
  };

  const snapshot = await fetchSnapshot({ http: deps.http, catalogFile: deps.catalogFile, session });
  member.snapshot = snapshot;
  member.lastSuccessAt = snapshot.fetchedAt;
  member.linkDeadNotified = false;
  await deps.save();
  return snapshot;
}

/** The message a member gets once when their sign-in stops working. */
export function linkDeadText(): string {
  return "Your Riot sign-in for the shop bot stopped working (it expired, or you changed your password or signed out everywhere). Run `/link` again to keep getting your daily shop.";
}
