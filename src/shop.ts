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
import { log } from "./log.ts";
import { type AuthDeps, authenticate, type Session, UnexpectedResponseError } from "./riot/auth.ts";
import { BadClaimsError, fetchOfferPrices, fetchStorefront, type Storefront } from "./riot/store.ts";

export interface ShopOffer {
  levelUuid: string;
  /** The skin name, or the UUID when the catalog does not know the item. */
  name: string;
  iconUrl: string | null;
  vp: number | null;
  tier: CatalogTier | null;
}

export interface ShopSnapshot {
  fetchedAt: string;
  expiresAt: string;
  offers: ShopOffer[];
  hash: string;
}

export interface ShopDeps extends AuthDeps {
  catalogFile?: string;
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
    };
  });
  return {
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    offers,
    hash: snapshotHash(storefront.offers, expiresAtMs),
  };
}

/** One run. Saves the snapshot in state; throws the typed errors the scheduler reacts to. */
export async function fetchShop(deps: ShopDeps): Promise<ShopSnapshot> {
  const { http, state } = deps;
  const catalogFile = deps.catalogFile ?? DEFAULT_CATALOG_FILE;
  const cached = await loadCatalog(catalogFile);

  let gameVersion = await resolveGameVersion(http, cached);
  let session = await authenticate(deps);

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
        session = await authenticate(deps);
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
  const fallbackPrices = await pricesIfMissing(deps, storefront, catalog, session, gameVersion.riotClientVersion, catalogFile);
  const snapshot = buildSnapshot(storefront, catalog, fallbackPrices);

  state.snapshot = snapshot;
  await deps.save(state);
  return snapshot;
}

/** E7, only when E6 lacks a price; cached in the catalog for this game version. */
async function pricesIfMissing(
  deps: ShopDeps,
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
    const prices = await fetchOfferPrices(deps.http, session, clientVersion);
    if (catalog) await saveCatalog({ ...catalog, prices }, catalogFile);
    return prices;
  } catch (err) {
    log.warn("E7 failed; those offers go out without a price", { error: err });
    return null;
  }
}
