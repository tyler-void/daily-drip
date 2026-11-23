import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShopOffer } from "../src/shop.ts";
import { emptyState } from "../src/state.ts";
import { addEntry, ensureWishlist, loadWishlist, MAX_ENTRIES, matchWishlist, removeEntry, suggest, wishlistPath } from "../src/wishlist.ts";

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

test("ensureWishlist imports the file once, then leaves the saved list alone", async () => {
  const path = join(dir, "wishlist.json");
  await writeFile(path, '["Reaver"]');
  const state = emptyState();
  expect(await ensureWishlist(state, path)).toBe(true);
  expect(state.wishlist).toEqual(["Reaver"]);

  state.wishlist = [];
  expect(await ensureWishlist(state, path)).toBe(false);
  expect(state.wishlist).toEqual([]);
});

test("addEntry tidies spaces and refuses duplicates, tiny entries and a full list", () => {
  expect(addEntry(["Reaver"], "  Prime   Vandal ")).toEqual({ ok: true, entries: ["Reaver", "Prime Vandal"], entry: "Prime Vandal" });
  expect(addEntry(["Reaver"], "REAVER").ok).toBe(false);
  expect(addEntry([], "a").ok).toBe(false);
  expect(addEntry([], "x".repeat(65)).ok).toBe(false);
  const full = Array.from({ length: MAX_ENTRIES }, (_, i) => `skin ${i}`);
  expect(addEntry(full, "one more").ok).toBe(false);
});

test("removeEntry matches case-insensitively and reports a miss", () => {
  expect(removeEntry(["Reaver", "Prime Vandal"], "prime vandal")).toEqual({ ok: true, entries: ["Reaver"], entry: "Prime Vandal" });
  expect(removeEntry(["Reaver"], "Kuronami")).toEqual({ ok: false, reason: "**Kuronami** is not on your wishlist." });
});

test("suggest puts names that start with the text first", () => {
  expect(suggest(["Prime Vandal", "Reaver Vandal", "Vandal Spectrum"], "vandal")).toEqual(["Vandal Spectrum", "Prime Vandal", "Reaver Vandal"]);
  expect(suggest(["a", "b", "c"], "", 2)).toEqual(["a", "b"]);
});

test("a missing or malformed wishlist is empty, not an error", async () => {
  expect(await loadWishlist(join(dir, "missing.json"))).toEqual([]);
  const bad = join(dir, "bad.json");
  await writeFile(bad, '{"skins": ["Reaver"]}');
  expect(await loadWishlist(bad)).toEqual([]);
});
