// The recap roster (Match Recap Spec: Roster & consent): who gets match recaps posted.
//
// Everyone on it put themselves there. The owner can remove people but never add them, and
// linking for the shop doesn't count as agreeing to public match recaps. Pure: no I/O. Styled
// after accounts.ts.
//
// Two tiers, decided by what the bot already holds:
//   linked:   the owner and members who /link'ed; their own Riot session gives exact RR.
//   followed: friends who aren't linked and add their own Riot ID; HenrikDev supplies their data.

export type RosterTier = "linked" | "followed";
/** presence: poll while Discord shows them playing VALORANT; poll: every 20 min, for no activity status. */
export type RosterTrigger = "presence" | "poll";

export interface RosterEntry {
  discordUserId: string;
  tier: RosterTier;
  /** /recap off keeps the entry with this false, so /recap on restores it. */
  enabled: boolean;
  trigger: RosterTrigger;
  puuid: string;
  /** "gameName#tagLine", for /recap list; refreshed from each match, since players rename. */
  riotName: string | null;
  /** HenrikDev region (e.g. "ap"); null for the linked tier, which uses the account's shard. */
  region: string | null;
  addedAt: string;
}

export type Roster = Record<string, RosterEntry>;

/** The HenrikDev budget's ceiling at the spec's poll intervals. */
export const MAX_FOLLOWED = 15;

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Who someone is to the bot, as far as /recap is concerned. */
export type Standing = { kind: "owner"; puuid: string | null } | { kind: "member"; puuid: string | null } | { kind: "none" };

/**
 * The owner's entry, created once and on by default (spec). Not recreated after the owner turns it
 * off: off stays off. Returns true when it was created, so the caller saves.
 */
export function ensureOwnerEntry(roster: Roster, owner: { discordUserId: string; puuid: string | null; riotName: string | null }, now = new Date()): boolean {
  if (roster[owner.discordUserId] || !owner.puuid) return false;
  roster[owner.discordUserId] = linkedEntry(owner.discordUserId, owner.puuid, owner.riotName, true, now);
  return true;
}

/** /recap on: the owner or a linked member joins (or rejoins) the linked tier. */
export function turnOn(roster: Roster, userId: string, standing: Standing, riotName: string | null, now = new Date()): Result<RosterEntry> {
  const existing = roster[userId];
  if (existing?.tier === "followed") {
    existing.enabled = true;
    return { ok: true, value: existing };
  }
  if (standing.kind === "none") return { ok: false, reason: "Link your Riot account with `/link` first, or follow your Riot ID with `/recap join`." };
  if (!standing.puuid) return { ok: false, reason: "Your link isn't finished yet; try again after your first shop." };
  const holder = findByPuuid(roster, standing.puuid);
  if (holder && holder.discordUserId !== userId) return { ok: false, reason: "That Riot account is already on the recap roster under someone else." };
  if (existing) {
    existing.enabled = true;
    existing.puuid = standing.puuid;
    return { ok: true, value: existing };
  }
  const entry = linkedEntry(userId, standing.puuid, riotName, true, now);
  roster[userId] = entry;
  return { ok: true, value: entry };
}

/** /recap off: stops recaps, keeps the entry. */
export function turnOff(roster: Roster, userId: string): Result<RosterEntry> {
  const entry = roster[userId];
  if (!entry) return { ok: false, reason: "You aren't on the recap roster." };
  entry.enabled = false;
  return { ok: true, value: entry };
}

/**
 * /recap join, after the Riot ID was resolved and the person confirmed: a server member who isn't
 * linked follows their own Riot ID. Linked people use /recap on instead.
 */
export function join(
  roster: Roster,
  userId: string,
  standing: Standing,
  account: { puuid: string; riotName: string; region: string },
  now = new Date(),
): Result<RosterEntry> {
  if (standing.kind !== "none") return { ok: false, reason: "Your Riot account is linked to the bot; use `/recap on` instead." };
  if (roster[userId]) return { ok: false, reason: "You're already on the recap roster; `/recap on` turns it back on." };
  if (findByPuuid(roster, account.puuid)) return { ok: false, reason: "That Riot account is already on the recap roster under someone else." };
  if (followed(roster).length >= MAX_FOLLOWED) return { ok: false, reason: `The recap roster already follows ${MAX_FOLLOWED} people, its limit.` };
  const entry: RosterEntry = {
    discordUserId: userId,
    tier: "followed",
    enabled: true,
    trigger: "presence",
    puuid: account.puuid,
    riotName: account.riotName,
    region: account.region,
    addedAt: now.toISOString(),
  };
  roster[userId] = entry;
  return { ok: true, value: entry };
}

/** /recap leave: a followed member deletes their entry. Linked people turn recaps off instead. */
export function leave(roster: Roster, userId: string): Result<RosterEntry> {
  const entry = roster[userId];
  if (!entry) return { ok: false, reason: "You aren't on the recap roster." };
  if (entry.tier === "linked") return { ok: false, reason: "You're on the roster through your link; `/recap off` stops your recaps, and `/unlink` removes you." };
  delete roster[userId];
  return { ok: true, value: entry };
}

/**
 * /recap remove (owner only; the caller checks): deletes a followed entry, or switches a linked one
 * off. The owner can never add anyone.
 */
export function remove(roster: Roster, userId: string): Result<{ entry: RosterEntry; deleted: boolean }> {
  const entry = roster[userId];
  if (!entry) return { ok: false, reason: "That user isn't on the recap roster." };
  if (entry.tier === "followed") {
    delete roster[userId];
    return { ok: true, value: { entry, deleted: true } };
  }
  entry.enabled = false;
  return { ok: true, value: { entry, deleted: false } };
}

/** A member unlinked: their linked recap entry goes with them (spec). */
export function onUnlink(roster: Roster, userId: string): boolean {
  if (roster[userId]?.tier !== "linked") return false;
  delete roster[userId];
  return true;
}

/** /recap trigger: poll on a timer for people who don't share their activity status. */
export function setTrigger(roster: Roster, userId: string, trigger: RosterTrigger): Result<RosterEntry> {
  const entry = roster[userId];
  if (!entry) return { ok: false, reason: "You aren't on the recap roster." };
  entry.trigger = trigger;
  return { ok: true, value: entry };
}

/** A player renamed: keep the shown Riot ID current. Returns true when it changed. */
export function refreshRiotName(roster: Roster, puuid: string, riotName: string | null): boolean {
  const entry = findByPuuid(roster, puuid);
  if (!entry || !riotName || entry.riotName === riotName) return false;
  entry.riotName = riotName;
  return true;
}

export function findByPuuid(roster: Roster, puuid: string): RosterEntry | null {
  return Object.values(roster).find((e) => e.puuid === puuid) ?? null;
}

/** Entries that get recaps now. */
export function active(roster: Roster): RosterEntry[] {
  return Object.values(roster).filter((e) => e.enabled);
}

export function followed(roster: Roster): RosterEntry[] {
  return Object.values(roster).filter((e) => e.tier === "followed");
}

function linkedEntry(userId: string, puuid: string, riotName: string | null, enabled: boolean, now: Date): RosterEntry {
  return { discordUserId: userId, tier: "linked", enabled, trigger: "presence", puuid, riotName, region: null, addedAt: now.toISOString() };
}
