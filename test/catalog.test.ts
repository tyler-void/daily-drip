import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCatalogEntries,
  AGENTS_URL,
  buildNames,
  MAPS_URL,
  RANKS_URL,
  levelItemName,
  type Catalog,
  CATALOG_SCHEMA,
  loadCatalog,
  refreshCatalog,
  resolveGameVersion,
  storeSkins,
  TIERS_URL,
  VERSION_URL,
  WEAPONS_URL,
  THEMES_URL,
} from "../src/catalog.ts";
import { FANDOM_API } from "../src/links.ts";
import { agentsData, fakeHttp, GAME_VERSION, linkRoutes, mapsData, ranksData, LEVEL_BULLDOG, LEVEL_JUDGE, LEVEL_VANDAL, LEVEL_VANDAL_2, themesData, TIER_EXCLUSIVE, tiersData, VANDAL_VIDEO, VANDAL_VIDEO_TOP, versionRoute, weaponsData } from "./fakes.ts";

describe("buildCatalogEntries", () => {
  const { skins, tiers } = buildCatalogEntries(weaponsData, tiersData, themesData);

  test("indexes every skin level by UUID, with the skin's name, weapon, tier, collection and video", () => {
    expect(skins[LEVEL_VANDAL]).toEqual({
      name: "Imperium Vandal",
      weapon: "Vandal",
      icon: "https://media.example/vandal-level1.png",
      tier: TIER_EXCLUSIVE,
      collection: "Imperium",
      video: VANDAL_VIDEO_TOP,
      level: 1,
      levelItem: null,
      levelVideo: VANDAL_VIDEO,
    });
    expect(skins[LEVEL_VANDAL_2]).toMatchObject({ level: 2, levelItem: "Kill banner", levelVideo: VANDAL_VIDEO_TOP });
    expect(skins[LEVEL_VANDAL_2]?.name).toBe("Imperium Vandal");
  });

  test("every level gets the fully upgraded (last) level's video; a skin without any has none", () => {
    expect(skins[LEVEL_VANDAL_2]?.video).toBe(VANDAL_VIDEO_TOP);
    expect(skins[LEVEL_JUDGE]?.video).toBeNull();
    expect(skins[LEVEL_JUDGE]?.collection).toBe("Celestial");
  });

  test("a skin whose theme is unknown, or missing themes, has no collection", () => {
    expect(skins[LEVEL_BULLDOG]?.collection).toBeNull();
    expect(buildCatalogEntries(weaponsData, tiersData).skins[LEVEL_VANDAL]?.collection).toBeNull();
  });

  test("a level without an icon falls back to the skin's icon, then the first chroma's render", () => {
    expect(skins[LEVEL_JUDGE]?.icon).toBe("https://media.example/judge-skin.png");
    expect(skins[LEVEL_VANDAL_2]?.icon).toBe("https://media.example/vandal-chroma.png");
    expect(skins[LEVEL_BULLDOG]?.icon).toBe("https://media.example/bulldog.png");
  });

  test("tiers use devName and drop the alpha from highlightColor", () => {
    expect(tiers[TIER_EXCLUSIVE]).toEqual({ name: "Exclusive", color: "f5955b" });
  });

  test("garbage input gives empty tables instead of throwing", () => {
    expect(buildCatalogEntries(null, { not: "an array" })).toEqual({ skins: {}, tiers: {} });
  });
});

test("storeSkins lists each store skin once with its weapon, and leaves out tierless ones", () => {
  const catalog: Catalog = { schema: CATALOG_SCHEMA, gameVersion: GAME_VERSION, fetchedAt: "", ...buildCatalogEntries(weaponsData, tiersData), prices: null, fandom: null };
  expect(storeSkins(catalog)).toEqual([
    { name: "Araxys Bulldog", weapon: "Bulldog" },
    { name: "Celestial Judge", weapon: "Judge" },
    { name: "Imperium Vandal", weapon: "Vandal" },
  ]);
  expect(storeSkins(null)).toEqual([]);
});

let dir: string;
let catalogFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daily-drip-catalog-"));
  catalogFile = join(dir, "catalog.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cachedCatalog = (version = GAME_VERSION): Catalog => ({
  schema: CATALOG_SCHEMA,
  gameVersion: version,
  fetchedAt: "2026-11-01T00:00:00.000Z",
  ...buildCatalogEntries(weaponsData, tiersData),
  prices: null,
  fandom: null,
});

// One Fandom query for both store collections: Imperium has a page, Celestial doesn't.
const FANDOM_QUERY = `${FANDOM_API}?${new URLSearchParams({ action: "query", format: "json", redirects: "1", titles: "Imperium Collection|Celestial Collection" })}`;

const catalogRoutes = {
  [WEAPONS_URL]: () => Response.json({ status: 200, data: weaponsData }),
  [TIERS_URL]: () => Response.json({ status: 200, data: tiersData }),
  [THEMES_URL]: () => Response.json({ status: 200, data: themesData }),
  [FANDOM_QUERY]: () =>
    Response.json({ query: { pages: { "1": { title: "Imperium Collection" }, "-1": { title: "Celestial Collection", missing: "" } } } }),
  [MAPS_URL]: () => Response.json({ status: 200, data: mapsData }),
  [AGENTS_URL]: () => Response.json({ status: 200, data: agentsData }),
  [RANKS_URL]: () => Response.json({ status: 200, data: ranksData }),
};

describe("refreshCatalog", () => {
  test("uses the cache when the game version matches, without any request", async () => {
    const { http, calls } = fakeHttp({});
    const cached = cachedCatalog();
    expect(await refreshCatalog(http, GAME_VERSION, cached, catalogFile)).toBe(cached);
    expect(calls).toHaveLength(0);
  });

  test("fetches E8, E9 and the themes after a game patch, checks Fandom once, and saves the new catalog", async () => {
    const { http, urls } = fakeHttp(catalogRoutes);
    const patched = { ...GAME_VERSION, version: "13.11.00.1" };
    const catalog = await refreshCatalog(http, patched, cachedCatalog(), catalogFile);
    expect(urls().sort()).toEqual([AGENTS_URL, FANDOM_QUERY, MAPS_URL, RANKS_URL, TIERS_URL, THEMES_URL, WEAPONS_URL].sort());
    expect(catalog?.fandom).toEqual({ Imperium: "Imperium Collection", Celestial: null });
    expect(catalog?.gameVersion.version).toBe("13.11.00.1");
    expect(catalog?.prices).toBeNull();
    expect((await loadCatalog(catalogFile))?.gameVersion.version).toBe("13.11.00.1");
  });

  test("a cache from an older schema is fetched again, even for the same game version", async () => {
    const { http, urls } = fakeHttp(catalogRoutes);
    const old = { ...cachedCatalog(), schema: 1 };
    const catalog = await refreshCatalog(http, GAME_VERSION, old, catalogFile);
    expect(urls()).toContain(WEAPONS_URL);
    expect(catalog?.schema).toBe(CATALOG_SCHEMA);
  });

  test("keeps the stale cache when valorant-api.com is down", async () => {
    const { http } = fakeHttp({ ...catalogRoutes, [WEAPONS_URL]: () => new Response("down", { status: 503 }) });
    const cached = cachedCatalog();
    expect(await refreshCatalog(http, { ...GAME_VERSION, version: "13.11.00.1" }, cached, catalogFile)).toBe(cached);
    expect(existsSync(catalogFile)).toBe(false);
  });

  test("returns null when it is down and nothing is cached", async () => {
    const { http } = fakeHttp({ ...catalogRoutes, [TIERS_URL]: () => new Response("down", { status: 503 }) });
    expect(await refreshCatalog(http, GAME_VERSION, null, catalogFile)).toBeNull();
  });
});

describe("resolveGameVersion", () => {
  test("reads E5", async () => {
    const { http } = fakeHttp({ [VERSION_URL]: versionRoute() });
    expect(await resolveGameVersion(http, null)).toEqual(GAME_VERSION);
  });

  test("falls back to the cached version when E5 fails", async () => {
    const { http } = fakeHttp({ [VERSION_URL]: () => new Response("down", { status: 500 }) });
    expect(await resolveGameVersion(http, cachedCatalog())).toEqual(GAME_VERSION);
  });

  test("fails when E5 fails and nothing is cached", async () => {
    const { http } = fakeHttp({ [VERSION_URL]: () => new Response("down", { status: 500 }) });
    await expect(resolveGameVersion(http, null)).rejects.toThrow("E5 version returned 500");
  });
});

test("levelItemName turns Riot's upgrade names into words", () => {
  expect(levelItemName("EEquippableSkinLevelItem::VFX")).toBe("VFX");
  expect(levelItemName("EEquippableSkinLevelItem::KillBanner")).toBe("Kill banner");
  expect(levelItemName("EEquippableSkinLevelItem::HeartbeatAndMapSensor")).toBe("Heartbeat and map sensor");
  expect(levelItemName(null)).toBeNull();
});

describe("refreshCatalog when the themes or Fandom fail", () => {
  test("the catalog is used but marked incomplete, and the next run builds it again", async () => {
    const { http } = fakeHttp({ ...catalogRoutes, [THEMES_URL]: () => new Response("timeout", { status: 504 }) });
    const first = await refreshCatalog(http, GAME_VERSION, null, catalogFile);
    expect(first?.incomplete).toBe(true);
    expect(Object.values(first?.skins ?? {}).every((s) => s.collection === null)).toBe(true);

    const second = fakeHttp(catalogRoutes);
    const rebuilt = await refreshCatalog(second.http, GAME_VERSION, first, catalogFile);
    expect(second.urls()).toContain(WEAPONS_URL);
    expect(rebuilt?.incomplete).toBe(false);
    expect(rebuilt?.skins[LEVEL_VANDAL]?.collection).toBe("Imperium");
  });

  test("a failed Fandom check also marks it incomplete", async () => {
    const { http } = fakeHttp({ ...catalogRoutes, [FANDOM_QUERY]: () => new Response("blocked", { status: 403 }) });
    const catalog = await refreshCatalog(http, GAME_VERSION, null, catalogFile);
    expect(catalog?.fandom).toBeNull();
    expect(catalog?.incomplete).toBe(true);
  });

  test("a complete catalog is kept for the game version", async () => {
    const built = await refreshCatalog(fakeHttp(catalogRoutes).http, GAME_VERSION, null, catalogFile);
    expect(built?.incomplete).toBe(false);
    const again = fakeHttp(catalogRoutes);
    expect(await refreshCatalog(again.http, GAME_VERSION, built, catalogFile)).toBe(built);
    expect(again.calls).toHaveLength(0);
  });
});

test("buildNames: maps by Riot path and by UUID, agents by UUID, ranks from the newest episode, title-cased", () => {
  const names = buildNames(mapsData, agentsData, ranksData);
  expect(names.maps).toEqual({ "/Game/Maps/Ascent/Ascent": "Ascent", "7eaecc1b-4337-bbf6-6ab9-04b8f06b3319": "Ascent" });
  expect(names.agents).toEqual({ "add6443a-41bd-e414-f6ad-e58d267f4e95": "Jett" });
  expect(names.ranks).toEqual({ "0": "Unranked", "13": "Gold 2" });
  expect(buildNames(null, {}, [])).toEqual({ maps: {}, agents: {}, ranks: {} });
});

test("refreshCatalog: failing name lists leave names null and mark the catalog incomplete", async () => {
  const { http } = fakeHttp({ ...catalogRoutes, ...linkRoutes(), [RANKS_URL]: () => new Response("down", { status: 503 }) });
  const catalog = await refreshCatalog(http, GAME_VERSION, null, catalogFile);
  expect(catalog?.names).toBeNull();
  expect(catalog?.incomplete).toBe(true);
  const ok = await refreshCatalog(fakeHttp({ ...catalogRoutes, ...linkRoutes() }).http, GAME_VERSION, null, catalogFile);
  expect(ok?.names?.maps["/Game/Maps/Ascent/Ascent"]).toBe("Ascent");
  expect(ok?.incomplete).toBe(false);
});
