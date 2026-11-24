// /recap show: a recap of anyone's recent match, on demand, as well as the automatic one after each
// match. Pure apart from the injected fetchers.
//
// Who: empty means the person asking. Otherwise a stored person (autocomplete values "user:<id>"),
// a Riot ID "Name#TAG" (a stored person with that Riot ID, else any account through HenrikDev),
// or a Discord username of someone the bot knows.
// Which: 1 is the latest match, 2 the one before, up to 10.
// From where: linked people (the owner, and members who /link'ed) through their own Riot session,
// with exact RR; everyone else through HenrikDev. A linked person whose Riot sign-in has died is read
// through HenrikDev too, rather than failing.

import type { HenrikAccount, Henrik } from "./henrik.ts";
import { log } from "./log.ts";
import { LoginDeadError } from "./riot/login.ts";
import type { MatchRecap } from "./recap.ts";
import type { RrState } from "./notify/recapMessage.ts";
import type { PdApi } from "./recapPoll.ts";
import type { RosterEntry } from "./roster.ts";

export const MAX_MATCH_NUMBER = 10;

/** Someone the bot knows: linked (owner or member, with a session) or followed (HenrikDev only). */
export interface Person {
  discordUserId: string;
  discordUsername: string | null;
  riotName: string | null;
  puuid: string;
  /** Linked people have their own Riot session; followed ones are read through HenrikDev. */
  linked: boolean;
  /** HenrikDev region, for followed people. */
  region: string | null;
}

export type Target =
  | { kind: "person"; person: Person }
  /** A Riot ID the bot doesn't know: HenrikDev only. */
  | { kind: "riot"; account: HenrikAccount };

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Autocomplete for "player": people the bot knows, matching what's typed; and a typed Riot ID to look up. */
export function playerChoices(people: Person[], typed: string, limit = 25): { name: string; value: string }[] {
  const q = typed.trim().toLowerCase();
  const label = (p: Person) => [p.discordUsername, p.riotName ? `(${p.riotName})` : null].filter(Boolean).join(" ") || p.puuid.slice(0, 8);
  const matches = people
    .filter((p) => !q || [p.discordUsername, p.riotName].some((n) => n?.toLowerCase().includes(q)))
    .sort((a, b) => label(a).localeCompare(label(b)))
    .map((p) => ({ name: label(p).slice(0, 100), value: `user:${p.discordUserId}` }));
  const out = typed.includes("#") && !people.some((p) => p.riotName?.toLowerCase() === q) ? [{ name: `Look up ${typed.trim()}`.slice(0, 100), value: `riot:${typed.trim()}`.slice(0, 100) }] : [];
  return [...out, ...matches].slice(0, limit);
}

export async function resolvePlayer(input: string | null, callerId: string, people: Person[], henrik: Henrik | null): Promise<Result<Target>> {
  const text = (input ?? "").trim();
  const byId = (id: string) => people.find((p) => p.discordUserId === id);

  if (!text) {
    const me = byId(callerId);
    return me ? { ok: true, value: { kind: "person", person: me } } : { ok: false, reason: "You aren't linked or followed on the bot; pick a player, or type a Riot ID like Name#TAG." };
  }
  if (text.startsWith("user:")) {
    const p = byId(text.slice(5));
    return p ? { ok: true, value: { kind: "person", person: p } } : { ok: false, reason: "That person isn't on the bot any more." };
  }
  const riotId = text.startsWith("riot:") ? text.slice(5) : text.includes("#") ? text : null;
  if (riotId) {
    const known = people.find((p) => p.riotName?.toLowerCase() === riotId.toLowerCase());
    if (known) return { ok: true, value: { kind: "person", person: known } };
    if (!henrik) return { ok: false, reason: "Looking up Riot IDs isn't set up on this bot (no HenrikDev key)." };
    const account = await henrik.account(riotId);
    return account ? { ok: true, value: { kind: "riot", account } } : { ok: false, reason: `No Riot account is called **${riotId}**.` };
  }
  // A Discord username of someone the bot knows: exact first, then a part only one name contains.
  const q = text.replace(/^@/, "").toLowerCase();
  const exact = people.find((p) => p.discordUsername?.toLowerCase() === q);
  const partial = people.filter((p) => p.discordUsername?.toLowerCase().includes(q));
  const person = exact ?? (partial.length === 1 ? partial[0] : undefined);
  if (person) return { ok: true, value: { kind: "person", person } };
  return { ok: false, reason: partial.length > 1 ? `**${text}** matches ${partial.length} people; pick one of the suggestions.` : `Nobody on the bot is called **${text}**. Type a Riot ID like Name#TAG to look anyone up.` };
}

export interface LookupDeps {
  pd: PdApi | null;
  henrik: Henrik | null;
}

/** The target's Nth most recent match (1 = latest), with their RR when it's a competitive match and known. */
export async function nthMatch(target: Target, n: number, deps: LookupDeps): Promise<Result<{ recap: MatchRecap; puuid: string; rr: Record<string, RrState> }>> {
  if (!Number.isInteger(n) || n < 1 || n > MAX_MATCH_NUMBER) return { ok: false, reason: `Pick a match number from 1 (latest) to ${MAX_MATCH_NUMBER}.` };
  const puuid = target.kind === "person" ? target.person.puuid : target.account.puuid;
  const none = (what: string) => ({ ok: false as const, reason: `${what} has no match number ${n} in their recent history.` });

  if (target.kind === "person" && target.person.linked && deps.pd) {
    const pd = deps.pd;
    const person = target.person;
    try {
      const session = await pd.session(asEntry(person));
      const history = await pd.history(session, n);
      const h = history[n - 1];
      if (!h) return none(person.riotName ?? "They");
      const recap = await pd.details(session, h.matchId);
      const rr: Record<string, RrState> = {};
      if (recap.queue === "competitive") {
        const update = (await pd.rr(session)).find((u) => u.matchId === recap.matchId);
        rr[puuid] = update ?? "none";
      }
      return { ok: true, value: { recap, puuid, rr } };
    } catch (err) {
      if (!(err instanceof LoginDeadError) || !deps.henrik) throw err;
      log.warn("a linked person's Riot sign-in is dead; reading their match through HenrikDev", { member: person.discordUsername ?? person.discordUserId });
    }
  }

  if (!deps.henrik) return { ok: false, reason: "Looking up matches for people who aren't linked needs a HenrikDev key." };
  const region = target.kind === "person" ? (target.person.region ?? "ap") : target.account.region;
  const list = await deps.henrik.matches(region, puuid, n);
  const recap = list[n - 1];
  const who = target.kind === "person" ? (target.person.riotName ?? "They") : `${target.account.name}#${target.account.tag}`;
  if (!recap) return none(who);
  const rr: Record<string, RrState> = {};
  if (recap.queue === "competitive") {
    const update = (await deps.henrik.rrHistory(region, puuid)).find((u) => u.matchId === recap.matchId);
    rr[puuid] = update ?? "none";
  }
  return { ok: true, value: { recap, puuid, rr } };
}

/** A linked person as the roster entry shape the session cache keys on. */
function asEntry(p: Person): RosterEntry {
  return { discordUserId: p.discordUserId, tier: "linked", enabled: true, trigger: "presence", puuid: p.puuid, riotName: p.riotName, region: null, addedAt: "" };
}
