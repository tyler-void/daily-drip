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
    };
  });
  return {
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    offers,
    hash: snapshotHash(storefront.offers, expiresAtMs),
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
