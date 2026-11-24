// The account registry: which Discord users may use the bot, and which Riot account each one
// has linked. Identity only. The cookies, shop snapshot and wishlist of a running account
// live elsewhere. One Riot account per Discord user, and one Discord user per Riot account.
//
// The link has two stable halves:
//   Discord side: the user id (the key). The username is kept for display; it can change.
//   Riot side:    the PUUID, once a login has succeeded. The Riot ID is kept for display.

export type AccountRole = "owner" | "member";

export interface LinkedAccount {
  /** The Discord user id. Also the key in the registry. */
  discordUserId: string;
  /** The Discord username when the user linked, or the last one seen. Display only. */
  discordUsername: string;
  /** The Riot PUUID once a login has succeeded; null until then. */
  puuid: string | null;
  /** The Riot ID ("gameName#tagLine") for display, once known. Never used for auth. */
  riotName: string | null;
  /** When the user first linked. ISO-8601. */
  linkedAt: string;
  /** The owner is added on every start; everyone else is a member. */
  role: AccountRole;
}

export type AccountRegistry = Record<string, LinkedAccount>;

/**
 * At most this many members besides the owner. Riot rate-limits an IP when many accounts sign in
 * close together, and each member is someone whose account access the server holds.
 */
export const MAX_MEMBERS = 10;

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Make sure the owner is in the registry, with the owner role. Returns true when the entry was
 * created or changed, so the caller knows to save. The owner's PUUID comes from the existing state.
 */
export function ensureOwner(
  registry: AccountRegistry,
  owner: { discordUserId: string; discordUsername: string; puuid: string | null },
  now = new Date(),
): boolean {
  const existing = registry[owner.discordUserId];
  if (!existing) {
    registry[owner.discordUserId] = {
      discordUserId: owner.discordUserId,
      discordUsername: owner.discordUsername,
      puuid: owner.puuid,
      riotName: null,
      linkedAt: now.toISOString(),
      role: "owner",
    };
    return true;
  }
  let changed = false;
  if (existing.role !== "owner") {
    existing.role = "owner";
    changed = true;
  }
  // A blank username means the lookup failed this start; keep the one already stored.
  if (owner.discordUsername && existing.discordUsername !== owner.discordUsername) {
    existing.discordUsername = owner.discordUsername;
    changed = true;
  }
  if (owner.puuid && existing.puuid !== owner.puuid) {
    existing.puuid = owner.puuid;
    changed = true;
  }
  return changed;
}

/** Add a Discord user as a member. The Riot side is filled in later, once their login succeeds. */
export function addMember(
  registry: AccountRegistry,
  member: { discordUserId: string; discordUsername: string },
  now = new Date(),
): Result<LinkedAccount> {
  const existing = registry[member.discordUserId];
  if (existing) {
    return { ok: false, reason: existing.role === "owner" ? "You're the bot's owner; your account is already set up." : "You're already linked." };
  }
  if (members(registry).length >= MAX_MEMBERS) {
    return { ok: false, reason: `The bot already has ${MAX_MEMBERS} linked members, its limit.` };
  }
  const account: LinkedAccount = {
    discordUserId: member.discordUserId,
    discordUsername: member.discordUsername,
    puuid: null,
    riotName: null,
    linkedAt: now.toISOString(),
    role: "member",
  };
  registry[member.discordUserId] = account;
  return { ok: true, value: account };
}

/**
 * Record which Riot account a Discord user signed in with. Refuses a Riot account that is already
 * linked to another Discord user: two entries for one account would split its cookie rotation.
 */
export function setRiotIdentity(
  registry: AccountRegistry,
  discordUserId: string,
  riot: { puuid: string; riotName: string | null },
): Result<LinkedAccount> {
  const account = registry[discordUserId];
  if (!account) return { ok: false, reason: "That Discord user isn't linked." };
  const other = findByPuuid(registry, riot.puuid);
  if (other && other.discordUserId !== discordUserId) {
    return { ok: false, reason: "That Riot account is already linked to another Discord user." };
  }
  account.puuid = riot.puuid;
  if (riot.riotName) account.riotName = riot.riotName;
  return { ok: true, value: account };
}

/** Remove a member and everything the registry holds about them. The owner can't be removed. */
export function removeMember(registry: AccountRegistry, discordUserId: string): Result<LinkedAccount> {
  const account = registry[discordUserId];
  if (!account) return { ok: false, reason: "You aren't linked." };
  if (account.role === "owner") return { ok: false, reason: "The owner's account is managed on the server, not with this command." };
  delete registry[discordUserId];
  return { ok: true, value: account };
}

export function findByPuuid(registry: AccountRegistry, puuid: string): LinkedAccount | null {
  return Object.values(registry).find((a) => a.puuid === puuid) ?? null;
}

/** Everyone but the owner, oldest link first. */
export function members(registry: AccountRegistry): LinkedAccount[] {
  return Object.values(registry)
    .filter((a) => a.role === "member")
    .sort((a, b) => a.linkedAt.localeCompare(b.linkedAt));
}

/** "username (Riot ID)" for messages; the Riot half only once known. */
export function displayName(account: LinkedAccount): string {
  return account.riotName ? `${account.discordUsername} (${account.riotName})` : account.discordUsername;
}
