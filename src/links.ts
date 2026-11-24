// Links on each skin in a shop post (spec: Messages): the collection's Fandom wiki page, a YouTube
// search for its trailer, and Riot's own preview video when the skin has one.
//
// Fandom's page titles are "<collection> Collection". Not every collection has one, so the titles
// are checked once per game version with Fandom's MediaWiki API and cached in the catalog; a
// missing page, or a failed check, links to Fandom's search instead.
// The trailer link is a YouTube search, so the query is visible and needs no API key.

import type { Http } from "./http.ts";
import { log } from "./log.ts";

export const FANDOM_WIKI = "https://valorant.fandom.com/wiki/";
export const FANDOM_API = "https://valorant.fandom.com/api.php";
const FANDOM_BATCH = 50; // MediaWiki's limit of titles per query
const USER_AGENT = "daily-drip (self-hosted Discord shop bot)";

export interface OfferLinks {
  fandom: string;
  trailer: string;
  /** Riot's in-game preview video of the fully upgraded skin; null when the skin has none. */
  preview: string | null;
}

/** Collection name -> its Fandom page title, or null when Fandom has no page for it. */
export type FandomTitles = Record<string, string | null>;

export function fandomPageUrl(title: string): string {
  return FANDOM_WIKI + encodeURIComponent(title.replaceAll(" ", "_"));
}

export function fandomSearchUrl(query: string): string {
  return `${FANDOM_WIKI}Special:Search?${new URLSearchParams({ query })}`;
}

export function trailerSearchUrl(collection: string): string {
  return `https://www.youtube.com/results?${new URLSearchParams({ search_query: `VALORANT ${collection} skins trailer` })}`;
}

/**
 * The links for one skin. `titles` is the cached Fandom check: a known page links straight to it;
 * a missing page, a collection the check didn't cover, or no check at all (null) links to search.
 */
export function offerLinks(collection: string, preview: string | null, titles: FandomTitles | null): OfferLinks {
  const title = titles?.[collection];
  return {
    fandom: title ? fandomPageUrl(title) : fandomSearchUrl(collection),
    trailer: trailerSearchUrl(collection),
    preview,
  };
}

/** A MediaWiki title can't contain these; such a collection just gets a search link. */
const INVALID_TITLE = /[#<>[\]{}|]/;

/**
 * Which collections have a Fandom page, following Fandom's own redirects. Best-effort: returns null
 * if the API can't be reached or answers oddly, and the posts then use search links.
 */
export async function resolveFandomTitles(http: Http, collections: string[]): Promise<FandomTitles | null> {
  const result: FandomTitles = {};
  const wanted = [...new Set(collections)];
  for (const name of wanted) if (INVALID_TITLE.test(name)) result[name] = null;
  const checkable = wanted.filter((name) => !INVALID_TITLE.test(name));
  try {
    for (let i = 0; i < checkable.length; i += FANDOM_BATCH) {
      const batch = checkable.slice(i, i + FANDOM_BATCH);
      const params = new URLSearchParams({ action: "query", format: "json", redirects: "1", titles: batch.map((n) => `${n} Collection`).join("|") });
      const res = await http.request(`${FANDOM_API}?${params}`, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`Fandom API answered ${res.status}`);
      const body = (await res.json()) as { query?: FandomQuery };
      const query = body.query;
      if (!query?.pages) throw new Error("Fandom API answer has no pages");
      const normalized = new Map((query.normalized ?? []).map((n) => [n.from, n.to]));
      const redirected = new Map((query.redirects ?? []).map((r) => [r.from, r.to]));
      const pages = new Map(Object.values(query.pages).map((p) => [p.title, p]));
      for (const name of batch) {
        const asked = `${name} Collection`;
        const title = normalized.get(asked) ?? asked;
        const final = redirected.get(title) ?? title;
        const page = pages.get(final);
        result[name] = page && !("missing" in page) && !("invalid" in page) ? final : null;
      }
    }
  } catch (err) {
    log.warn("could not check Fandom's collection pages; shop posts link to Fandom search", { error: err });
    return null;
  }
  const found = Object.values(result).filter((t) => t !== null).length;
  log.info("checked Fandom collection pages", { collections: wanted.length, pages: found });
  return result;
}

interface FandomQuery {
  normalized?: { from: string; to: string }[];
  redirects?: { from: string; to: string }[];
  pages?: Record<string, { title: string; missing?: string; invalid?: string }>;
}
