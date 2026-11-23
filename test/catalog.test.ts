import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCatalogEntries,
  type Catalog,
  loadCatalog,
  refreshCatalog,
  resolveGameVersion,
  TIERS_URL,
  VERSION_URL,
  WEAPONS_URL,
} from "../src/catalog.ts";
import { fakeHttp, GAME_VERSION, LEVEL_BULLDOG, LEVEL_JUDGE, LEVEL_VANDAL, LEVEL_VANDAL_2, TIER_EXCLUSIVE, tiersData, versionRoute, weaponsData } from "./fakes.ts";

describe("buildCatalogEntries", () => {
  const { skins, tiers } = buildCatalogEntries(weaponsData, tiersData);

  test("indexes every skin level by UUID, with the skin's name and tier", () => {
    expect(skins[LEVEL_VANDAL]).toEqual({ name: "Imperium Vandal", icon: "https://media.example/vandal-level1.png", tier: TIER_EXCLUSIVE });
    expect(skins[LEVEL_VANDAL_2]?.name).toBe("Imperium Vandal");
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
  gameVersion: version,
  fetchedAt: "2026-11-01T00:00:00.000Z",
  ...buildCatalogEntries(weaponsData, tiersData),
  prices: null,
});

const catalogRoutes = {
  [WEAPONS_URL]: () => Response.json({ status: 200, data: weaponsData }),
  [TIERS_URL]: () => Response.json({ status: 200, data: tiersData }),
};

describe("refreshCatalog", () => {
  test("uses the cache when the game version matches, without any request", async () => {
    const { http, calls } = fakeHttp({});
    const cached = cachedCatalog();
    expect(await refreshCatalog(http, GAME_VERSION, cached, catalogFile)).toBe(cached);
    expect(calls).toHaveLength(0);
  });

  test("fetches E8 and E9 after a game patch and saves the new catalog", async () => {
    const { http, urls } = fakeHttp(catalogRoutes);
    const patched = { ...GAME_VERSION, version: "13.11.00.1" };
    const catalog = await refreshCatalog(http, patched, cachedCatalog(), catalogFile);
    expect(urls().sort()).toEqual([TIERS_URL, WEAPONS_URL]);
    expect(catalog?.gameVersion.version).toBe("13.11.00.1");
    expect(catalog?.prices).toBeNull();
    expect((await loadCatalog(catalogFile))?.gameVersion.version).toBe("13.11.00.1");
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
