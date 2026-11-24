import { expect, test } from "bun:test";
import type { Http, RequestOptions } from "../src/http.ts";
import { FANDOM_API, fandomPageUrl, fandomSearchUrl, offerLinks, resolveFandomTitles, trailerSearchUrl } from "../src/links.ts";

test("URL builders: Fandom page, Fandom search, and a YouTube search whose query is readable", () => {
  expect(fandomPageUrl("RGX 11z Pro Collection")).toBe("https://valorant.fandom.com/wiki/RGX_11z_Pro_Collection");
  expect(fandomPageUrl("Arcane Collector's Set")).toBe("https://valorant.fandom.com/wiki/Arcane_Collector's_Set");
  expect(fandomSearchUrl("Prime//2.0")).toBe("https://valorant.fandom.com/wiki/Special:Search?query=Prime%2F%2F2.0");
  expect(trailerSearchUrl("Reaver")).toBe("https://www.youtube.com/results?search_query=VALORANT+Reaver+skins+trailer");
});

test("offerLinks: a known page links to it; missing, unchecked or no check at all links to search", () => {
  const titles = { Reaver: "Reaver Collection", Gourmand: null };
  expect(offerLinks("Reaver", "https://v.example/a.mp4", titles)).toEqual({
    fandom: "https://valorant.fandom.com/wiki/Reaver_Collection",
    trailer: trailerSearchUrl("Reaver"),
    preview: "https://v.example/a.mp4",
  });
  expect(offerLinks("Gourmand", null, titles).fandom).toBe(fandomSearchUrl("Gourmand"));
  expect(offerLinks("Brand New", null, titles).fandom).toBe(fandomSearchUrl("Brand New"));
  expect(offerLinks("Reaver", null, null).fandom).toBe(fandomSearchUrl("Reaver"));
});

/** A fake Fandom API: answers each batch from a fixed set of pages, normalizations and redirects. */
function fandom(pages: Record<string, "page" | "missing">, redirects: Record<string, string> = {}, normalized: Record<string, string> = {}) {
  const batches: string[][] = [];
  const http: Http = {
    async request(url: string, _options?: RequestOptions) {
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe(FANDOM_API);
      const asked = (u.searchParams.get("titles") ?? "").split("|");
      batches.push(asked);
      const titles = asked.map((t) => redirects[normalized[t] ?? t] ?? normalized[t] ?? t);
      return Response.json({
        query: {
          normalized: asked.filter((t) => normalized[t]).map((t) => ({ from: t, to: normalized[t] })),
          redirects: asked.filter((t) => redirects[normalized[t] ?? t]).map((t) => ({ from: normalized[t] ?? t, to: redirects[normalized[t] ?? t] })),
          pages: Object.fromEntries(titles.map((t, i) => [pages[t] === "page" ? String(i + 1) : String(-1 - i), pages[t] === "page" ? { title: t } : { title: t, missing: "" }])),
        },
      });
    },
  };
  return { http, batches };
}

test("resolveFandomTitles follows Fandom's normalization and redirects, and marks missing pages", async () => {
  const { http } = fandom(
    { "Reaver Collection": "page", "Arcane Collector's Set": "page", "Prime 2.0 Collection": "page" },
    { "Arcane Collection": "Arcane Collector's Set" },
    { "prime 2.0 Collection": "Prime 2.0 Collection" },
  );
  expect(await resolveFandomTitles(http, ["Reaver", "Arcane", "prime 2.0", "Gourmand", "Reaver"])).toEqual({
    Reaver: "Reaver Collection",
    Arcane: "Arcane Collector's Set",
    "prime 2.0": "Prime 2.0 Collection",
    Gourmand: null,
  });
});

test("resolveFandomTitles asks 50 titles at a time and skips names MediaWiki can't hold", async () => {
  const names = Array.from({ length: 120 }, (_, i) => `Set ${i}`);
  const { http, batches } = fandom({});
  const result = await resolveFandomTitles(http, [...names, "A|B", "C#D"]);
  expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
  expect(result?.["A|B"]).toBeNull();
  expect(result?.["C#D"]).toBeNull();
  expect(batches.flat()).not.toContain("A|B Collection");
});

test("resolveFandomTitles returns null when Fandom fails, so posts fall back to search links", async () => {
  const down: Http = { request: async () => new Response("blocked", { status: 403 }) };
  expect(await resolveFandomTitles(down, ["Reaver"])).toBeNull();
  const odd: Http = { request: async () => Response.json({ error: { code: "readonly" } }) };
  expect(await resolveFandomTitles(odd, ["Reaver"])).toBeNull();
});
