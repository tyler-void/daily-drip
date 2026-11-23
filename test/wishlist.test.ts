import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShopOffer } from "../src/shop.ts";
import { loadWishlist, matchWishlist, wishlistPath } from "../src/wishlist.ts";

const offer = (name: string, levelUuid = `${name}-uuid`): ShopOffer => ({ levelUuid, name, iconUrl: null, vp: 1775, tier: null });
const shop = [offer("Reaver Vandal"), offer("Prime Phantom"), offer("Celestial Judge", "AAAA-1111")];

test("names match case-insensitively as substrings", () => {
  expect(matchWishlist(shop, ["reaver"]).map((o) => o.name)).toEqual(["Reaver Vandal"]);
  expect(matchWishlist(shop, ["PRIME"]).map((o) => o.name)).toEqual(["Prime Phantom"]);
});

test("a UUID matches the offer's level UUID", () => {
  expect(matchWishlist(shop, ["aaaa-1111"]).map((o) => o.name)).toEqual(["Celestial Judge"]);
});

test("no entries, or no matching ones, give no hits", () => {
  expect(matchWishlist(shop, [])).toEqual([]);
  expect(matchWishlist(shop, ["Kuronami"])).toEqual([]);
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daily-drip-wishlist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the wishlist sits next to the cookie file", () => {
  expect(wishlistPath(join("config", "riot-cookie"))).toBe(join("config", "wishlist.json"));
});

test("loadWishlist reads a JSON array, trims it and skips blanks", async () => {
  const path = join(dir, "wishlist.json");
  await writeFile(path, '﻿[" Reaver ", "", 42, "Prime Vandal"]');
  expect(await loadWishlist(path)).toEqual(["Reaver", "Prime Vandal"]);
});

test("a missing or malformed wishlist is empty, not an error", async () => {
  expect(await loadWishlist(join(dir, "missing.json"))).toEqual([]);
  const bad = join(dir, "bad.json");
  await writeFile(bad, '{"skins": ["Reaver"]}');
  expect(await loadWishlist(bad)).toEqual([]);
});
