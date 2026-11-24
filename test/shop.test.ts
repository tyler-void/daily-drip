import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalogEntries, type Catalog, CATALOG_SCHEMA, loadCatalog, saveCatalog, TIERS_URL, VERSION_URL, WEAPONS_URL } from "../src/catalog.ts";
import { REAUTH_URL, UnexpectedResponseError, USERINFO_URL } from "../src/riot/auth.ts";
import { BadClaimsError, MaintenanceError } from "../src/riot/store.ts";
import { buildSnapshot, fetchShop, findStoreSkin, type ShopDeps, skinLevels, snapshotHash, withLinks } from "../src/shop.ts";
import { emptyState, type State } from "../src/state.ts";
import {
  fakeRiot,
  GAME_VERSION,
  LEVEL_BULLDOG,
  LEVEL_JUDGE,
  LEVEL_UNKNOWN,
  LEVEL_VANDAL,
  LEVEL_VANDAL_2,
  OFFERS_URL,
  type Route,
  STOREFRONT_URL,
  storefrontBody,
  themesData,
  tiersData,
  VANDAL_VIDEO,
  VANDAL_VIDEO_TOP,
  versionRoute,
  weaponsData,
} from "./fakes.ts";

const MIDNIGHT = Date.parse("2026-11-24T00:00:00Z");

describe("snapshotHash", () => {
  test("a few seconds of drift in expiresAt gives the same hash", () => {
    const uuids = [LEVEL_VANDAL, LEVEL_JUDGE];
    expect(snapshotHash(uuids, MIDNIGHT - 2_000)).toBe(snapshotHash(uuids, MIDNIGHT + 1_000));
  });

  test("offer order does not matter", () => {
    expect(snapshotHash([LEVEL_VANDAL, LEVEL_JUDGE], MIDNIGHT)).toBe(snapshotHash([LEVEL_JUDGE, LEVEL_VANDAL], MIDNIGHT));
  });

  test("the same offers on another day give another hash", () => {
    expect(snapshotHash([LEVEL_VANDAL], MIDNIGHT)).not.toBe(snapshotHash([LEVEL_VANDAL], MIDNIGHT + 86_400_000));
  });
});

const catalog = (): Catalog => ({ schema: CATALOG_SCHEMA, gameVersion: GAME_VERSION, fetchedAt: "2026-11-01T00:00:00.000Z", ...buildCatalogEntries(weaponsData, tiersData, themesData), prices: null, fandom: { Imperium: "Imperium Collection", Celestial: null } });

describe("buildSnapshot", () => {
  const now = MIDNIGHT - 3_600_000;

  test("maps offers to names, icons, prices and tiers", () => {
    const storefront = { offers: [LEVEL_VANDAL, LEVEL_JUDGE], remainingSeconds: 3600, prices: { [LEVEL_VANDAL]: 2175, [LEVEL_JUDGE]: 1775 } };
    const snapshot = buildSnapshot(storefront, catalog(), null, now);
    expect(snapshot.fetchedAt).toBe("2026-11-23T23:00:00.000Z");
    expect(snapshot.expiresAt).toBe("2026-11-24T00:00:00.000Z");
    expect(snapshot.offers[0]).toEqual({
      levelUuid: LEVEL_VANDAL,
      name: "Imperium Vandal",
      iconUrl: "https://media.example/vandal-level1.png",
      vp: 2175,
      tier: { name: "Exclusive", color: "f5955b" },
      links: {
        fandom: "https://valorant.fandom.com/wiki/Imperium_Collection",
        trailer: "https://www.youtube.com/results?search_query=VALORANT+Imperium+skins+trailer",
        preview: VANDAL_VIDEO_TOP,
      },
    });
    // No Fandom page and no video: a Fandom search, and no preview.
    expect(snapshot.offers[1]?.links).toEqual({
      fandom: "https://valorant.fandom.com/wiki/Special:Search?query=Celestial",
      trailer: "https://www.youtube.com/results?search_query=VALORANT+Celestial+skins+trailer",
      preview: null,
    });
    expect(snapshot.hash).toBe(snapshotHash([LEVEL_VANDAL, LEVEL_JUDGE], MIDNIGHT));
  });

  test("an item the catalog does not know shows its UUID and price", () => {
    const snapshot = buildSnapshot({ offers: [LEVEL_UNKNOWN], remainingSeconds: 60, prices: { [LEVEL_UNKNOWN]: 875 } }, catalog(), null, now);
    expect(snapshot.offers[0]).toEqual({ levelUuid: LEVEL_UNKNOWN, name: LEVEL_UNKNOWN, iconUrl: null, vp: 875, tier: null, links: null });
  });

  test("without any catalog every item shows its UUID", () => {
    const snapshot = buildSnapshot({ offers: [LEVEL_VANDAL], remainingSeconds: 60, prices: {} }, null, null, now);
    expect(snapshot.offers[0]?.name).toBe(LEVEL_VANDAL);
  });

  test("E7 prices fill in what E6 lacks", () => {
    const snapshot = buildSnapshot({ offers: [LEVEL_BULLDOG], remainingSeconds: 60, prices: {} }, catalog(), { [LEVEL_BULLDOG]: 2175 }, now);
    expect(snapshot.offers[0]?.vp).toBe(2175);
  });
});

// ---------- fetchShop() against a fake Riot ----------

const OFFERS = [LEVEL_VANDAL, LEVEL_JUDGE, LEVEL_BULLDOG, LEVEL_UNKNOWN];
const PRICES = { [LEVEL_VANDAL]: 2175, [LEVEL_JUDGE]: 1775, [LEVEL_BULLDOG]: 2175, [LEVEL_UNKNOWN]: 875 };

let dir: string;
let state: State;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daily-drip-shop-"));
  await writeFile(join(dir, "riot-cookie"), "ssid=original");
  state = emptyState();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function shopRiot(overrides: Record<string, Route> = {}) {
  return fakeRiot({
    [VERSION_URL]: versionRoute(),
    [STOREFRONT_URL]: () => Response.json(storefrontBody(OFFERS, PRICES)),
    [WEAPONS_URL]: () => Response.json({ status: 200, data: weaponsData }),
    [TIERS_URL]: () => Response.json({ status: 200, data: tiersData }),
    ...overrides,
  });
}

function deps(http: ShopDeps["http"]): ShopDeps {
  return {
    http,
    state,
    save: async () => {},
    cookieFile: join(dir, "riot-cookie"),
    spikeJarFile: join(dir, "no-spike-jar.json"),
    catalogFile: join(dir, "catalog.json"),
  };
}

describe("fetchShop", () => {
  test("happy path: version, auth, storefront, catalog; the snapshot lands in state", async () => {
    const riot = shopRiot();
    const snapshot = await fetchShop(deps(riot.http));
    expect(snapshot.offers.map((o) => o.name)).toEqual(["Imperium Vandal", "Celestial Judge", "Araxys Bulldog", LEVEL_UNKNOWN]);
    expect(snapshot.offers.map((o) => o.vp)).toEqual([2175, 1775, 2175, 875]);
    expect(state.snapshot).toEqual(snapshot);
    expect(riot.urls()).not.toContain(OFFERS_URL);
    const e6 = riot.calls.find((c) => c.url === STOREFRONT_URL);
    expect(e6?.options.method).toBe("POST");
    expect(e6?.options.body).toBe("{}");
    expect(e6?.options.headers?.["X-Riot-ClientVersion"]).toBe(GAME_VERSION.riotClientVersion);
    expect(e6?.options.headers?.["X-Riot-Entitlements-JWT"]).toBe("ENT");
  });

  test("the second run uses the cached catalog", async () => {
    await fetchShop(deps(shopRiot().http));
    const second = shopRiot();
    await fetchShop(deps(second.http));
    expect(second.urls()).not.toContain(WEAPONS_URL);
  });

  test("BAD_CLAIMS once: reauth and retry", async () => {
    const riot = shopRiot({
      [STOREFRONT_URL]: (_o, nth) => (nth === 1 ? Response.json({ httpStatus: 400, errorCode: "BAD_CLAIMS" }, { status: 400 }) : Response.json(storefrontBody(OFFERS, PRICES))),
    });
    await fetchShop(deps(riot.http));
    expect(riot.urls().filter((u) => u === REAUTH_URL)).toHaveLength(2);
  });

  test("BAD_CLAIMS twice ends the run with BadClaimsError", async () => {
    const riot = shopRiot({ [STOREFRONT_URL]: () => Response.json({ httpStatus: 400, errorCode: "BAD_CLAIMS" }, { status: 400 }) });
    await expect(fetchShop(deps(riot.http))).rejects.toBeInstanceOf(BadClaimsError);
    expect(riot.urls().filter((u) => u === STOREFRONT_URL)).toHaveLength(2);
  });

  test("E6 fails after a patch: refetch E5 and retry with the new client version", async () => {
    const patched = { ...GAME_VERSION, version: "13.11.00.1", riotClientVersion: "release-13.11-shipping-1" };
    const riot = shopRiot({
      [VERSION_URL]: (_o, nth) => versionRoute(nth === 1 ? GAME_VERSION : patched)({}, nth),
      [STOREFRONT_URL]: (o) =>
        o.headers?.["X-Riot-ClientVersion"] === patched.riotClientVersion ? Response.json(storefrontBody(OFFERS, PRICES)) : new Response("bad version", { status: 400 }),
    });
    const snapshot = await fetchShop(deps(riot.http));
    expect(snapshot.offers).toHaveLength(4);
    expect(riot.urls().filter((u) => u === VERSION_URL)).toHaveLength(2);
  });

  test("E6 fails and E5 has nothing newer: the run fails without a retry", async () => {
    const riot = shopRiot({ [STOREFRONT_URL]: () => new Response("oops", { status: 500 }) });
    await expect(fetchShop(deps(riot.http))).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(riot.urls().filter((u) => u === STOREFRONT_URL)).toHaveLength(1);
  });

  test("maintenance ends the run at once", async () => {
    const riot = shopRiot({ [STOREFRONT_URL]: () => Response.json({ httpStatus: 403, errorCode: "SCHEDULED_DOWNTIME" }, { status: 403 }) });
    await expect(fetchShop(deps(riot.http))).rejects.toBeInstanceOf(MaintenanceError);
    expect(riot.urls().filter((u) => u === STOREFRONT_URL)).toHaveLength(1);
  });

  test("E6 without prices falls back to E7 and caches its prices in the catalog", async () => {
    const riot = shopRiot({
      [STOREFRONT_URL]: () => Response.json(storefrontBody(OFFERS)),
      [OFFERS_URL]: () => Response.json({ Offers: Object.entries(PRICES).map(([id, vp]) => ({ OfferID: id, Cost: { "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741": vp } })) }),
    });
    const snapshot = await fetchShop(deps(riot.http));
    expect(snapshot.offers.map((o) => o.vp)).toEqual([2175, 1775, 2175, 875]);
    expect((await loadCatalog(join(dir, "catalog.json")))?.prices?.[LEVEL_JUDGE]).toBe(1775);
  });

  test("valorant-api.com down: cached version and catalog still produce a full shop", async () => {
    await saveCatalog(catalog(), join(dir, "catalog.json"));
    const down = () => new Response("down", { status: 503 });
    const riot = shopRiot({ [VERSION_URL]: down, [WEAPONS_URL]: down, [TIERS_URL]: down });
    const snapshot = await fetchShop(deps(riot.http));
    expect(snapshot.offers[0]?.name).toBe("Imperium Vandal");
  });
});

test("the owner's run hands each new session to onSession (it carries the Riot ID for the shop post)", async () => {
  const riot = shopRiot({ [USERINFO_URL]: () => Response.json({ sub: "puuid-1234-5678", acct: { game_name: "Owner", tag_line: "0001" } }) });
  const seen: Array<string | null> = [];
  await fetchShop({ ...deps(riot.http), onSession: (session) => void seen.push(session.riotName) });
  expect(seen).toEqual(["Owner#0001"]);
});

describe("withLinks", () => {
  test("a shop saved before links gets them from the current catalog", () => {
    const old = buildSnapshot({ offers: [LEVEL_VANDAL, LEVEL_UNKNOWN], remainingSeconds: 60, prices: {} }, catalog(), null, MIDNIGHT);
    for (const o of old.offers) delete o.links;
    const shown = withLinks(old, catalog());
    expect(shown?.offers[0]?.links?.fandom).toBe("https://valorant.fandom.com/wiki/Imperium_Collection");
    expect(shown?.offers[0]?.links?.preview).toBe(VANDAL_VIDEO_TOP);
    expect(shown?.offers[1]?.links).toBeNull();
    expect(old.offers[0]?.links).toBeUndefined(); // the saved one is not changed
  });

  test("a shop that already has links, no shop, or no catalog is returned as it is", () => {
    const fresh = buildSnapshot({ offers: [LEVEL_VANDAL], remainingSeconds: 60, prices: {} }, catalog(), null, MIDNIGHT);
    expect(withLinks(fresh, catalog())).toBe(fresh);
    expect(withLinks(null, catalog())).toBeNull();
    const old = { ...fresh, offers: fresh.offers.map(({ links: _, ...o }) => o) };
    expect(withLinks(old, null)).toBe(old);
  });
});

describe("findStoreSkin (/preview)", () => {
  test("an exact name (any case) gives the shop's level with the fully upgraded video", () => {
    const found = findStoreSkin(catalog(), "imperium vandal");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.offer).toMatchObject({ levelUuid: LEVEL_VANDAL, name: "Imperium Vandal", vp: null, tier: { name: "Exclusive" } });
    expect(found.offer.links?.preview).toBe(VANDAL_VIDEO_TOP);
    expect(found.level).toBeNull();
    expect(found.levels).toBe(2);
  });

  test("a level gives that level's image and its own video", () => {
    const one = findStoreSkin(catalog(), "Imperium Vandal", 1);
    const two = findStoreSkin(catalog(), "Imperium Vandal", 2);
    if (!one.ok || !two.ok) throw new Error("not found");
    expect(one.offer.links?.preview).toBe(VANDAL_VIDEO);
    expect(one.level).toMatchObject({ level: 1, label: "Base" });
    expect(two.offer.levelUuid).toBe(LEVEL_VANDAL_2);
    expect(two.level).toMatchObject({ level: 2, label: "Kill banner", video: VANDAL_VIDEO_TOP });
  });

  test("a level the skin doesn't have, an unknown or ambiguous name, or too little text is refused", () => {
    expect(findStoreSkin(catalog(), "Imperium Vandal", 3)).toEqual({ ok: false, reason: "**Imperium Vandal** has 2 levels; pick one of the suggestions." });
    expect(findStoreSkin(catalog(), "Kuronami").ok).toBe(false);
    expect(findStoreSkin(catalog(), "a").ok).toBe(false);
    expect(findStoreSkin(null, "Imperium Vandal").ok).toBe(false);
    // "Standard Vandal" has no tier, so only "Imperium Vandal" counts and "vandal" is unique.
    const vandal = findStoreSkin(catalog(), "vandal");
    expect(vandal.ok && vandal.offer.name).toBe("Imperium Vandal");
  });

  test("skinLevels lists a skin's levels in order with what each adds", () => {
    expect(skinLevels(catalog(), "Imperium Vandal").map((l) => `${l.level}:${l.label}:${l.video ? "video" : "-"}`)).toEqual(["1:Base:video", "2:Kill banner:video"]);
  });
});
