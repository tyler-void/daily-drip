// A fake Riot + valorant-api.com for tests, with synthetic data (no real tokens or account data).

import type { Http, RequestOptions } from "../src/http.ts";
import { ENTITLEMENTS_URL, PAS_URL, REAUTH_URL, USERINFO_URL } from "../src/riot/auth.ts";
import { VP } from "../src/riot/store.ts";

export const OK_LOCATION =
  "https://playvalorant.com/opt_in#access_token=AT&scope=account+openid&iss=x&id_token=IT&token_type=Bearer&expires_in=3600";
export const PUUID = "puuid-1234-5678";
export const STOREFRONT_URL = `https://pd.ap.a.pvp.net/store/v3/storefront/${PUUID}`;
export const OFFERS_URL = "https://pd.ap.a.pvp.net/store/v1/offers/";

export function headers(init: Record<string, string>, setCookies: string[] = []): Headers {
  const h = new Headers(init);
  for (const line of setCookies) h.append("set-cookie", line);
  return h;
}

export interface Call {
  url: string;
  options: RequestOptions;
}

/** A route gets the request and how many times its URL has been called (1 for the first call). */
export type Route = (options: RequestOptions, nth: number) => Response;

export function fakeHttp(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const http: Http = {
    async request(url, options = {}) {
      calls.push({ url, options });
      const nth = (counts.get(url) ?? 0) + 1;
      counts.set(url, nth);
      const route = routes[url];
      if (!route) throw new Error(`unexpected request to ${url}`);
      return route(options, nth);
    },
  };
  return { http, calls, urls: () => calls.map((c) => c.url) };
}

export function authRoutes(): Record<string, Route> {
  return {
    [REAUTH_URL]: () => new Response(null, { status: 303, headers: headers({ location: OK_LOCATION }, ["ssid=rotated; Path=/", "ccid=new; Path=/"]) }),
    [ENTITLEMENTS_URL]: () => Response.json({ entitlements_token: "ENT" }),
    [USERINFO_URL]: () => Response.json({ sub: PUUID }),
    [PAS_URL]: () => Response.json({ affinities: { live: "ap" } }),
  };
}

export function fakeRiot(overrides: Record<string, Route> = {}) {
  return fakeHttp({ ...authRoutes(), ...overrides });
}

// ---------- synthetic valorant-api.com and storefront data ----------

export const TIER_EXCLUSIVE = "e046854e-406c-37f4-6607-19a9ba8426fc";
export const TIER_SELECT = "12683d76-48d7-84a3-4e09-6985794f0445";
export const LEVEL_VANDAL = "aaaaaaaa-0000-0000-0000-000000000001";
export const LEVEL_VANDAL_2 = "aaaaaaaa-0000-0000-0000-000000000002";
export const LEVEL_JUDGE = "bbbbbbbb-0000-0000-0000-000000000001";
export const LEVEL_BULLDOG = "cccccccc-0000-0000-0000-000000000001";
export const LEVEL_UNKNOWN = "dddddddd-0000-0000-0000-000000000001";
export const THEME_IMPERIUM = "11111111-0000-0000-0000-000000000001";
export const THEME_CELESTIAL = "11111111-0000-0000-0000-000000000002";
export const VANDAL_VIDEO = "https://video.example/imperium-vandal-level1.mp4";
export const VANDAL_VIDEO_TOP = "https://video.example/imperium-vandal-level2.mp4";

export const themesData = [
  { uuid: THEME_IMPERIUM, displayName: "Imperium" },
  { uuid: THEME_CELESTIAL, displayName: "Celestial" },
];

export const weaponsData = [
  {
    displayName: "Vandal",
    skins: [
      {
        displayName: "Imperium Vandal",
        contentTierUuid: TIER_EXCLUSIVE,
        themeUuid: THEME_IMPERIUM,
        displayIcon: null,
        chromas: [{ fullRender: "https://media.example/vandal-chroma.png" }],
        levels: [
          { uuid: LEVEL_VANDAL, displayName: "Imperium Vandal", displayIcon: "https://media.example/vandal-level1.png", streamedVideo: VANDAL_VIDEO },
          { uuid: LEVEL_VANDAL_2, displayName: "Imperium Vandal Level 2", displayIcon: null, streamedVideo: VANDAL_VIDEO_TOP },
        ],
      },
      { displayName: "Standard Vandal", contentTierUuid: null, displayIcon: "https://media.example/std.png", chromas: [], levels: [{ uuid: "std-level", displayIcon: null }] },
    ],
  },
  {
    displayName: "Judge",
    skins: [
      { displayName: "Celestial Judge", contentTierUuid: TIER_SELECT, themeUuid: THEME_CELESTIAL, displayIcon: "https://media.example/judge-skin.png", chromas: [], levels: [{ uuid: LEVEL_JUDGE, displayIcon: null }] },
    ],
  },
  {
    displayName: "Bulldog",
    skins: [
      { displayName: "Araxys Bulldog", contentTierUuid: TIER_SELECT, displayIcon: null, chromas: [], levels: [{ uuid: LEVEL_BULLDOG, displayIcon: "https://media.example/bulldog.png" }] },
    ],
  },
];

export const tiersData = [
  { uuid: TIER_EXCLUSIVE, displayName: "Exclusive Edition", devName: "Exclusive", highlightColor: "f5955b33" },
  { uuid: TIER_SELECT, displayName: "Select Edition", devName: "Select", highlightColor: "5a9fe233" },
];

export const GAME_VERSION = { version: "13.10.00.1", riotClientVersion: "release-13.10-shipping-1", riotClientBuild: "1.0.0" };

export function versionRoute(version = GAME_VERSION): Route {
  return () => Response.json({ status: 200, data: { ...version, branch: "release-13.10" } });
}

export function storefrontBody(offers: string[], prices: Record<string, number> = {}, remainingSeconds = 74_340) {
  return {
    FeaturedBundle: {},
    SkinsPanelLayout: {
      SingleItemOffers: offers,
      SingleItemOffersRemainingDurationInSeconds: remainingSeconds,
      SingleItemStoreOffers: Object.entries(prices).map(([id, vp]) => ({ OfferID: id, Cost: { [VP]: vp } })),
    },
    AccessoryStore: {},
  };
}
