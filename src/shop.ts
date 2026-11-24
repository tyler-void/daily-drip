// One shop run (build step 3): auth -> E6 -> catalog -> ShopSnapshot, with the
// "retry once" rows of the spec's Error handling table. The scheduler (step 5) decides when.

import { createHash } from "node:crypto";
import {
  type Catalog,
  type CatalogTier,
  DEFAULT_CATALOG_FILE,
  fetchGameVersion,
  loadCatalog,
  refreshCatalog,
  resolveGameVersion,
  saveCatalog,
} from "./catalog.ts";
import type { Http } from "./http.ts";
import { type OfferLinks, offerLinks } from "./links.ts";
import { log } from "./log.ts";
import { type AuthDeps, authenticate, type Session, UnexpectedResponseError } from "./riot/auth.ts";
import { BadClaimsError, fetchOfferPrices, fetchStorefront, type Storefront } from "./riot/store.ts";
import { noAlerts } from "./state.ts";

export interface ShopOffer {
  levelUuid: string;
  /** The skin name, or the UUID when the catalog does not know the item. */
  name: string;
  iconUrl: string | null;
  vp: number | null;
  tier: CatalogTier | null;
  /** Fandom, trailer and preview links; absent for an unknown item and in snapshots saved before links. */
  links?: OfferLinks | null;
}

export interface ShopSnapshot {
  fetchedAt: string;
  expiresAt: string;
  offers: ShopOffer[];
  hash: string;
}

export interface ShopDeps extends AuthDeps {
  catalogFile?: string;
  /** Called with each new session, e.g. to keep the owner's Riot ID for shop posts. */
  onSession?: (session: Session) => void;
}

/** Where a shop run gets its session: the owner's cookie, or a member's refresh token. */
export interface ShopSource {
  http: Http;
  catalogFile?: string;
  /** A fresh session. Called once more if E6 answers BAD_CLAIMS. */
  session(): Promise<Session>;
}

const TEN_MINUTES = 10 * 60 * 1000;
/** Spec: retries inside one run are capped at 3; then the scheduler's retry timer takes over. */
const MAX_RETRIES = 3;

/**
 * sha256 of the sorted offer UUIDs + expiresAt rounded to 10 minutes. expiresAt comes
 * from a remaining-seconds count and moves by a second or so between fetches; the
 * rounding keeps a restart from resending the same shop.
 */
export function snapshotHash(levelUuids: string[], expiresAtMs: number): string {
  const rounded = new Date(Math.round(expiresAtMs / TEN_MINUTES) * TEN_MINUTES).toISOString();
  return createHash("sha256").update(`${[...levelUuids].sort().join(",")}|${rounded}`).digest("hex");
}

export function buildSnapshot(
  storefront: Storefront,
  catalog: Catalog | null,
  fallbackPrices: Record<string, number> | null,
  now = Date.now(),
): ShopSnapshot {
  const expiresAtMs = now + storefront.remainingSeconds * 1000;
  const offers = storefront.offers.map((levelUuid): ShopOffer => {
    const skin = catalog?.skins[levelUuid];
    const tier = skin?.tier ? (catalog?.tiers[skin.tier] ?? null) : null;
    return {
      levelUuid,
      name: skin?.name ?? levelUuid,
      iconUrl: skin?.icon ?? null,
      vp: storefront.prices[levelUuid] ?? fallbackPrices?.[levelUuid] ?? null,
      tier,
      links: skin?.collection ? offerLinks(skin.collection, skin.video ?? null, catalog?.fandom ?? null) : null,
    };
  });
  return {
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    offers,
    hash: snapshotHash(storefront.offers, expiresAtMs),
  };
}

/**
 * A saved snapshot as it should be shown now: offers saved before links existed (no `links` key) get
 * them from the current catalog. Offers that already have links, or `links: null`, are left alone.
 */
export function withLinks(snapshot: ShopSnapshot | null, catalog: Catalog | null): ShopSnapshot | null {
  if (!snapshot || !catalog || snapshot.offers.every((o) => "links" in o)) return snapshot;
  return {
    ...snapshot,
    offers: snapshot.offers.map((o) => {
      if ("links" in o) return o;
      const skin = catalog.skins[o.levelUuid];
      return { ...o, links: skin?.collection ? offerLinks(skin.collection, skin.video ?? null, catalog.fandom ?? null) : null };
    }),
  };
}

/** One level of a store skin, for /preview. */
export interface SkinLevel {
  level: number;
  levelUuid: string;
  /** "Base" for level 1, otherwise what the level adds, e.g. "VFX". */
  label: string;
  video: string | null;
}

/**
 * Which store skin the user means: an exact name first (case-insensitive), then a part of a name that
 * only one skin contains.
 */
export function resolveStoreSkin(catalog: Catalog | null, typed: string): { ok: true; name: string } | { ok: false; reason: string } {
  if (!catalog) return { ok: false, reason: "The skin list isn't loaded yet; try again in a minute." };
  const query = typed.trim().toLowerCase();
  if (query.length < 2) return { ok: false, reason: "Type at least 2 letters of a skin name, then pick one of the suggestions." };
  const names = [...new Set(Object.values(catalog.skins).filter((s) => s.tier !== null).map((s) => s.name))];
  const exact = names.find((n) => n.toLowerCase() === query);
  const partial = names.filter((n) => n.toLowerCase().includes(query));
  const name = exact ?? (partial.length === 1 ? partial[0] : undefined);
  if (name) return { ok: true, name };
  return {
    ok: false,
    reason: partial.length === 0 ? `No store skin is called **${typed.trim()}**.` : `**${typed.trim()}** matches ${partial.length} skins; pick one of the suggestions.`,
  };
}

/** A store skin's levels, in order. */
export function skinLevels(catalog: Catalog, name: string): SkinLevel[] {
  return Object.entries(catalog.skins)
    .filter(([, s]) => s.name === name && s.tier !== null)
    .map(([levelUuid, s]) => ({ level: s.level ?? 1, levelUuid, label: s.levelItem ?? "Base", video: s.levelVideo ?? null }))
    .sort((a, b) => a.level - b.level);
}

/**
 * A store skin as an offer-shaped card for /preview. Without a level, the card shows the level the
 * shop sells and the fully upgraded video; with one, that level's image and its own video.
 */
export function findStoreSkin(
  catalog: Catalog | null,
  typed: string,
  level: number | null = null,
): { ok: true; offer: ShopOffer; level: SkinLevel | null; levels: number } | { ok: false; reason: string } {
  const resolved = resolveStoreSkin(catalog, typed);
  if (!resolved.ok || !catalog) return resolved.ok ? { ok: false, reason: "The skin list isn't loaded yet." } : resolved;
  const levels = skinLevels(catalog, resolved.name);
  const chosen = level === null ? null : levels.find((l) => l.level === level);
  if (level !== null && !chosen) {
    return { ok: false, reason: `**${resolved.name}** has ${levels.length} level${levels.length === 1 ? "" : "s"}; pick one of the suggestions.` };
  }
  const levelUuid = (chosen ?? levels[0])?.levelUuid as string;
  const skin = catalog.skins[levelUuid] as Catalog["skins"][string];
  const video = chosen ? chosen.video : (skin.video ?? null);
  return {
    ok: true,
    level: chosen ?? null,
    levels: levels.length,
    offer: {
      levelUuid,
      name: skin.name,
      iconUrl: skin.icon,
      vp: null,
      tier: skin.tier ? (catalog.tiers[skin.tier] ?? null) : null,
      links: skin.collection ? offerLinks(skin.collection, video, catalog.fandom ?? null) : null,
    },
  };
}

/** The owner's run. Saves the snapshot in state; throws the typed errors the scheduler reacts to. */
export async function fetchShop(deps: ShopDeps): Promise<ShopSnapshot> {
  const { state } = deps;
  const session = async () => {
    const fresh = await authenticate(deps);
    deps.onSession?.(fresh);
    return fresh;
  };
  const snapshot = await fetchSnapshot({ http: deps.http, catalogFile: deps.catalogFile, session });
  // A successful run clears every alert flag (spec: Storage & secrets).
  state.snapshot = snapshot;
  state.lastSuccessAt = snapshot.fetchedAt;
  state.flags = noAlerts();
  await deps.save(state);
  return snapshot;
}

/**
 * Session -> E6 -> catalog -> ShopSnapshot, with the "retry once" rows of the error table. Works for
 * any session source and saves nothing; the caller stores the snapshot where it belongs.
 */
export async function fetchSnapshot(source: ShopSource): Promise<ShopSnapshot> {
  const { http } = source;
  const catalogFile = source.catalogFile ?? DEFAULT_CATALOG_FILE;
  const cached = await loadCatalog(catalogFile);

  let gameVersion = await resolveGameVersion(http, cached);
  let session = await source.session();

  let storefront: Storefront | undefined;
  let retries = 0;
  let reauthed = false;
  let versionRefetched = false;
  while (!storefront) {
    try {
      storefront = await fetchStorefront(http, session, gameVersion.riotClientVersion);
    } catch (err) {
      if (retries >= MAX_RETRIES) throw err;
      if (err instanceof BadClaimsError && !reauthed) {
        // Tokens are minutes old, so this is odd; reauth once, and a second time ends the run.
        log.warn("E6 answered BAD_CLAIMS; reauthenticating once");
        reauthed = true;
        retries++;
        session = await source.session();
        continue;
      }
      if (err instanceof UnexpectedResponseError && !versionRefetched) {
        // Maybe a game patch just landed and X-Riot-ClientVersion is stale.
        versionRefetched = true;
        const fresh = await fetchGameVersion(http).catch(() => null);
        if (fresh && fresh.riotClientVersion !== gameVersion.riotClientVersion) {
          log.warn("E6 failed; retrying with the newer client version", { from: gameVersion.riotClientVersion, to: fresh.riotClientVersion });
          retries++;
          gameVersion = fresh;
          continue;
        }
      }
      throw err;
    }
  }

  const catalog = await refreshCatalog(http, gameVersion, cached, catalogFile);
  const fallbackPrices = await pricesIfMissing(http, storefront, catalog, session, gameVersion.riotClientVersion, catalogFile);
  return buildSnapshot(storefront, catalog, fallbackPrices);
}

/** E7, only when E6 lacks a price; cached in the catalog for this game version. */
async function pricesIfMissing(
  http: Http,
  storefront: Storefront,
  catalog: Catalog | null,
  session: Session,
  clientVersion: string,
  catalogFile: string,
): Promise<Record<string, number> | null> {
  if (storefront.offers.every((id) => storefront.prices[id] !== undefined)) return null;
  if (catalog?.prices) return catalog.prices;
  log.warn("E6 has no price for some offers; falling back to E7");
  try {
    const prices = await fetchOfferPrices(http, session, clientVersion);
    if (catalog) await saveCatalog({ ...catalog, prices }, catalogFile);
    return prices;
  } catch (err) {
    log.warn("E7 failed; those offers go out without a price", { error: err });
    return null;
  }
}
