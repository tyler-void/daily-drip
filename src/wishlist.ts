// Wishlist (spec: Schedule & notifications): config/wishlist.json, next to the cookie file,
// re-read on every run. A JSON array of skin names or UUIDs; names match case-insensitively
// as substrings, so "Reaver" matches every Reaver skin.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "./log.ts";
import type { ShopOffer } from "./shop.ts";

export const wishlistPath = (cookieFile: string) => join(dirname(cookieFile), "wishlist.json");

export async function loadWishlist(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return []; // no wishlist is fine
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ""));
    if (Array.isArray(parsed)) {
      return parsed.filter((e): e is string => typeof e === "string" && e.trim() !== "").map((e) => e.trim());
    }
  } catch {
    // fall through
  }
  log.warn('wishlist.json is not a JSON array of strings, e.g. ["Reaver", "Prime Vandal"]; ignoring it', { path });
  return [];
}

export function matchWishlist(offers: ShopOffer[], entries: string[]): ShopOffer[] {
  const wanted = entries.map((e) => e.toLowerCase());
  return offers.filter((offer) => wanted.some((w) => offer.levelUuid.toLowerCase() === w || offer.name.toLowerCase().includes(w)));
}
