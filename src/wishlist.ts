// Wishlist (spec: Schedule & notifications). Managed with /wishlist and kept in data/state.json.
// Entries are skin names or parts of one, matched case-insensitively: "Reaver" matches every
// Reaver skin. A skin-level UUID also works. An existing config/wishlist.json is imported once.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "./log.ts";
import type { ShopOffer } from "./shop.ts";
import type { State } from "./state.ts";

/** 25 keeps the /wishlist list reply under Discord's 2000-character limit. */
export const MAX_ENTRIES = 25;
export const MAX_ENTRY_LENGTH = 64;

export const wishlistPath = (cookieFile: string) => join(dirname(cookieFile), "wishlist.json");

/** Read config/wishlist.json, a JSON array of strings. Missing or malformed means empty. */
export async function loadWishlist(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ""));
    if (Array.isArray(parsed)) {
      return parsed.filter((e): e is string => typeof e === "string" && e.trim() !== "").map(cleanEntry);
    }
  } catch {
    // fall through
  }
  log.warn('wishlist.json is not a JSON array of strings, e.g. ["Reaver", "Prime Vandal"]; ignoring it', { path });
  return [];
}

/** First start with /wishlist support: take over config/wishlist.json, if there is one. */
export async function ensureWishlist(state: State, path: string): Promise<boolean> {
  if (state.wishlist !== null) return false;
  state.wishlist = (await loadWishlist(path)).slice(0, MAX_ENTRIES);
  if (state.wishlist.length > 0) log.info("imported the wishlist file; from now on use /wishlist", { path, entries: state.wishlist.length });
  return true;
}

export function matchWishlist(offers: ShopOffer[], entries: string[]): ShopOffer[] {
  const wanted = entries.map((e) => e.toLowerCase());
  return offers.filter((offer) => wanted.some((w) => offer.levelUuid.toLowerCase() === w || offer.name.toLowerCase().includes(w)));
}

export function cleanEntry(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export type WishlistChange = { ok: true; entries: string[]; entry: string } | { ok: false; reason: string };

export function addEntry(entries: string[], raw: string): WishlistChange {
  const entry = cleanEntry(raw);
  if (entry.length < 2) return { ok: false, reason: "That is too short: use at least 2 characters, or it would match almost every skin." };
  if (entry.length > MAX_ENTRY_LENGTH) return { ok: false, reason: `That is too long: ${MAX_ENTRY_LENGTH} characters at most.` };
  const existing = entries.find((e) => e.toLowerCase() === entry.toLowerCase());
  if (existing) return { ok: false, reason: `**${existing}** is already on your wishlist.` };
  if (entries.length >= MAX_ENTRIES) return { ok: false, reason: `Your wishlist is full (${MAX_ENTRIES} entries). Remove one first.` };
  return { ok: true, entries: [...entries, entry], entry };
}

export function removeEntry(entries: string[], raw: string): WishlistChange {
  const wanted = cleanEntry(raw).toLowerCase();
  const existing = entries.find((e) => e.toLowerCase() === wanted);
  if (!existing) return { ok: false, reason: `**${cleanEntry(raw)}** is not on your wishlist.` };
  return { ok: true, entries: entries.filter((e) => e !== existing), entry: existing };
}

/** Autocomplete: names containing what was typed, those starting with it first. */
export function suggest(names: string[], typed: string, limit = 25): string[] {
  const query = cleanEntry(typed).toLowerCase();
  const matches = names.filter((n) => n.toLowerCase().includes(query));
  const starts = matches.filter((n) => n.toLowerCase().startsWith(query));
  const rest = matches.filter((n) => !n.toLowerCase().startsWith(query));
  return [...starts, ...rest].slice(0, limit);
}
