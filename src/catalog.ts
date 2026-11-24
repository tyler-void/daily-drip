// Game version (E5) and the skin catalog (E8, E9) from valorant-api.com (spec: Data mapping).
// The catalog is cached in data/catalog.json per game version. It is kept apart from
// state.json because it is about 0.5 MB and changes only after a game patch, while
// state.json is rewritten on every cookie rotation.

import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./files.ts";
import { type Http, NetworkError } from "./http.ts";
import { type FandomTitles, resolveFandomTitles } from "./links.ts";
import { log } from "./log.ts";
import { UnexpectedResponseError } from "./riot/auth.ts";

export const VERSION_URL = "https://valorant-api.com/v1/version";
export const WEAPONS_URL = "https://valorant-api.com/v1/weapons";
export const TIERS_URL = "https://valorant-api.com/v1/contenttiers";
export const THEMES_URL = "https://valorant-api.com/v1/themes";
export const DEFAULT_CATALOG_FILE = "data/catalog.json";
/** Bump when the cached shape changes, so an older catalog.json is fetched again. */
export const CATALOG_SCHEMA = 3;

export interface GameVersion {
  version: string;
  riotClientVersion: string;
  riotClientBuild: string;
}

export interface CatalogSkin {
  name: string;
  /** The gun's name, e.g. "Vandal"; "Melee" for knives. */
  weapon: string;
  icon: string | null;
  tier: string | null;
  /** The collection (valorant-api.com theme), e.g. "Reaver"; null when unknown. */
  collection: string | null;
  /** Riot's preview video for this level, or the first level of the skin that has one. */
  video: string | null;
}

/** A store skin for /wishlist autocomplete. */
export interface StoreSkin {
  name: string;
  weapon: string;
}

export interface CatalogTier {
  name: string;
  /** "rrggbb", from highlightColor without its alpha. */
  color: string;
}

export interface Catalog {
  schema: number;
  gameVersion: GameVersion;
  fetchedAt: string;
  /** Keyed by skin-level UUID: the storefront's offer IDs are level UUIDs. */
  skins: Record<string, CatalogSkin>;
  tiers: Record<string, CatalogTier>;
  /** E7 prices (offer ID -> VP), only filled if the storefront ever stops carrying prices. */
  prices: Record<string, number> | null;
  /** Which collections have a Fandom page (src/links.ts); null if that check failed. */
  fandom: FandomTitles | null;
}

export async function fetchGameVersion(http: Http): Promise<GameVersion> {
  const body = await getJson(http, VERSION_URL, "E5 version");
  const data = (body.data ?? {}) as Record<string, unknown>;
  const { version, riotClientVersion, riotClientBuild } = data;
  if (typeof version !== "string" || typeof riotClientVersion !== "string" || typeof riotClientBuild !== "string") {
    throw new UnexpectedResponseError("E5 version: missing version fields");
  }
  return { version, riotClientVersion, riotClientBuild };
}

/** E5, or the cached catalog's version while valorant-api.com is down. */
export async function resolveGameVersion(http: Http, cached: Catalog | null): Promise<GameVersion> {
  try {
    return await fetchGameVersion(http);
  } catch (err) {
    if (!isThirdPartyOutage(err) || !cached) throw err;
    log.warn("valorant-api.com is unavailable; using the cached game version", { version: cached.gameVersion.version, error: err });
    return cached.gameVersion;
  }
}

/** Turn E8 (weapons), E9 (content tiers) and the themes into the lookup tables the snapshot needs. */
export function buildCatalogEntries(weapons: unknown, tiers: unknown, themes: unknown = []): Pick<Catalog, "skins" | "tiers"> {
  const themeNames = new Map<string, string>();
  for (const theme of asArray(themes)) {
    const uuid = text(field(theme, "uuid"));
    const name = text(field(theme, "displayName"));
    if (uuid && name) themeNames.set(uuid, name);
  }
  const skins: Record<string, CatalogSkin> = {};
  for (const weapon of asArray(weapons)) {
    const weaponName = text(field(weapon, "displayName")) ?? "Unknown";
    for (const skin of asArray(field(weapon, "skins"))) {
      const name = text(field(skin, "displayName"));
      if (!name) continue;
      const tier = text(field(skin, "contentTierUuid"));
      const firstChroma = asArray(field(skin, "chromas"))[0];
      const skinIcon = text(field(skin, "displayIcon")) ?? text(field(firstChroma, "fullRender"));
      const themeUuid = text(field(skin, "themeUuid"));
      const collection = themeUuid ? (themeNames.get(themeUuid) ?? null) : null;
      const levels = asArray(field(skin, "levels"));
      const anyVideo = levels.map((l) => text(field(l, "streamedVideo"))).find((v) => v !== null) ?? null;
      for (const level of levels) {
        const uuid = text(field(level, "uuid"));
        if (!uuid) continue;
        const video = text(field(level, "streamedVideo")) ?? anyVideo;
        skins[uuid] = { name, weapon: weaponName, icon: text(field(level, "displayIcon")) ?? skinIcon, tier, collection, video };
      }
    }
  }
  const tierTable: Record<string, CatalogTier> = {};
  for (const tier of asArray(tiers)) {
    const uuid = text(field(tier, "uuid"));
    const name = text(field(tier, "devName")) ?? text(field(tier, "displayName"));
    const color = text(field(tier, "highlightColor"));
    if (uuid && name) tierTable[uuid] = { name, color: color ? color.slice(0, 6) : "ffffff" };
  }
  return { skins, tiers: tierTable };
}

/** Every store skin (one with a content tier) once, sorted by name, for /wishlist autocomplete. */
export function storeSkins(catalog: Catalog | null): StoreSkin[] {
  if (!catalog) return [];
  const byName = new Map<string, StoreSkin>();
  for (const skin of Object.values(catalog.skins)) {
    if (skin.tier !== null && !byName.has(skin.name)) byName.set(skin.name, { name: skin.name, weapon: skin.weapon });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadCatalog(path = DEFAULT_CATALOG_FILE): Promise<Catalog | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Catalog;
  } catch {
    return null; // missing or unreadable: it is only a cache
  }
}

export async function saveCatalog(catalog: Catalog, path = DEFAULT_CATALOG_FILE): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(catalog), 0o644);
}

/**
 * The catalog for this game version: the cache when it matches, otherwise E8 + E9.
 * If valorant-api.com is down, the stale cache (or null) is returned: the shop still
 * goes out, and unknown items show their UUID (spec: Error handling).
 */
export async function refreshCatalog(
  http: Http,
  gameVersion: GameVersion,
  cached: Catalog | null,
  path = DEFAULT_CATALOG_FILE,
): Promise<Catalog | null> {
  const usable = cached?.schema === CATALOG_SCHEMA && Object.keys(cached.skins).length > 0;
  if (usable && cached.gameVersion.version === gameVersion.version) return cached;
  try {
    // Themes only add collection names (for the links); a failure there must not stop the shop.
    const [weapons, tiers, themes] = await Promise.all([
      getJson(http, WEAPONS_URL, "E8 weapons", 30_000),
      getJson(http, TIERS_URL, "E9 content tiers"),
      getJson(http, THEMES_URL, "themes").catch((err: unknown) => {
        log.warn("could not fetch skin collections; shop posts go out without links", { error: err });
        return { data: [] };
      }),
    ]);
    const entries = buildCatalogEntries(weapons.data, tiers.data, themes.data);
    // Only collections of store skins: the daily shop never offers the others.
    const collections = [...new Set(Object.values(entries.skins).flatMap((s) => (s.tier !== null && s.collection ? [s.collection] : [])))];
    const catalog: Catalog = {
      schema: CATALOG_SCHEMA,
      gameVersion,
      fetchedAt: new Date().toISOString(),
      ...entries,
      prices: null,
      fandom: collections.length > 0 ? await resolveFandomTitles(http, collections) : null,
    };
    await saveCatalog(catalog, path);
    log.info("catalog refreshed", { version: gameVersion.version, skins: Object.keys(catalog.skins).length });
    return catalog;
  } catch (err) {
    if (!isThirdPartyOutage(err)) throw err;
    log.warn("valorant-api.com is unavailable; using the cached catalog", { cachedVersion: cached?.gameVersion.version ?? null, error: err });
    return cached;
  }
}

async function getJson(http: Http, url: string, what: string, timeoutMs?: number): Promise<Record<string, unknown>> {
  const res = await http.request(url, { timeoutMs });
  if (!res.ok) throw new UnexpectedResponseError(`${what} returned ${res.status}`);
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new UnexpectedResponseError(`${what} returned a body that is not a JSON object`);
}

function isThirdPartyOutage(err: unknown): boolean {
  return err instanceof NetworkError || err instanceof UnexpectedResponseError;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
