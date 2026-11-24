// Storefront (E6) and the offers fallback (E7) (spec: Endpoints & headers, Data mapping).

import type { Http } from "../http.ts";
import { parseRetryAfter, RateLimitedError, type Session, UnexpectedResponseError } from "./auth.ts";

export const VP = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741";
// base64 of the platform JSON, tab-indented with \r\n (spec: 4 game headers).
export const CLIENT_PLATFORM =
  "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9";

/** E6 rejected the token. Reauth once and retry; a second time ends the run (never "cookie dead"). */
export class BadClaimsError extends Error {
  name = "BadClaimsError";
}

/** Riot maintenance (SkinPeek's isMaintenance). Skip; retry in 30 min. */
export class MaintenanceError extends Error {
  name = "MaintenanceError";
}

export interface Storefront {
  /** Skin-level UUIDs of the daily offers. */
  offers: string[];
  remainingSeconds: number;
  /** Offer ID -> VP, from SingleItemStoreOffers. */
  prices: Record<string, number>;
}

export const storefrontUrl = (session: Session) => `https://pd.${session.shard}.a.pvp.net/store/v3/storefront/${session.puuid}`;
export const offersUrl = (session: Session) => `https://pd.${session.shard}.a.pvp.net/store/v1/offers/`;

export function gameHeaders(session: Session, clientVersion: string): Record<string, string> {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "X-Riot-Entitlements-JWT": session.entitlementsToken,
    "X-Riot-ClientVersion": clientVersion,
    "X-Riot-ClientPlatform": CLIENT_PLATFORM,
  };
}

export async function fetchStorefront(http: Http, session: Session, clientVersion: string): Promise<Storefront> {
  const res = await http.request(storefrontUrl(session), {
    method: "POST",
    headers: { ...gameHeaders(session, clientVersion), "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.status === 429) throw new RateLimitedError("E6 storefront", parseRetryAfter(res.headers.get("retry-after")));
  return parseStorefront(res.status, await readJsonObject(res));
}

/** Read an E6 answer: the daily offers, or the error the spec's table names. */
export function parseStorefront(status: number, body: Record<string, unknown> | null): Storefront {
  const errorCode = typeof body?.errorCode === "string" ? body.errorCode : null;
  if (errorCode === "BAD_CLAIMS") throw new BadClaimsError("E6 storefront: BAD_CLAIMS");
  if (errorCode === "SCHEDULED_DOWNTIME") throw new MaintenanceError("E6 storefront: SCHEDULED_DOWNTIME (maintenance)");
  if (status !== 200 || !body) throw new UnexpectedResponseError(`E6 storefront returned ${status}${errorCode ? ` ${errorCode}` : ""}`);

  const panel = body.SkinsPanelLayout as Record<string, unknown> | undefined;
  const offers = panel?.SingleItemOffers;
  const remainingSeconds = panel?.SingleItemOffersRemainingDurationInSeconds;
  if (!Array.isArray(offers) || !offers.every((o) => typeof o === "string") || typeof remainingSeconds !== "number") {
    throw new UnexpectedResponseError("E6 storefront: no SkinsPanelLayout.SingleItemOffers");
  }

  const prices: Record<string, number> = {};
  const storeOffers = Array.isArray(panel?.SingleItemStoreOffers) ? panel.SingleItemStoreOffers : [];
  for (const offer of storeOffers as Array<{ OfferID?: unknown; Cost?: Record<string, unknown> }>) {
    const vp = offer?.Cost?.[VP];
    if (typeof offer?.OfferID === "string" && typeof vp === "number") prices[offer.OfferID] = vp;
  }
  return { offers: offers as string[], remainingSeconds, prices };
}

/** E7: every offer's price. Only needed if E6 stops carrying prices. */
export async function fetchOfferPrices(http: Http, session: Session, clientVersion: string): Promise<Record<string, number>> {
  const res = await http.request(offersUrl(session), { headers: gameHeaders(session, clientVersion) });
  if (res.status === 429) throw new RateLimitedError("E7 offers", parseRetryAfter(res.headers.get("retry-after")));
  const body = await readJsonObject(res);
  if (res.status !== 200 || !body || !Array.isArray(body.Offers)) throw new UnexpectedResponseError(`E7 offers returned ${res.status}`);
  const prices: Record<string, number> = {};
  for (const offer of body.Offers as Array<{ OfferID?: unknown; Cost?: Record<string, unknown> }>) {
    const vp = offer?.Cost?.[VP];
    if (typeof offer?.OfferID === "string" && typeof vp === "number") prices[offer.OfferID] = vp;
  }
  return prices;
}

async function readJsonObject(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
