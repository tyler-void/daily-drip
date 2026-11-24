// The recap as an image, in the owner's Enhalation design language (Mocha): ground and ink from
// Catppuccin Mocha, glass panels, the warm core (halo peach -> pink, mauve bleed) for the one big
// moment, a single teal spark, Bricolage Grotesque for display, Geist for text, Geist Mono for
// numbers that align, and grain over everything.
//
// Satori lays it out as SVG (it measures text with the bundled fonts); the grain is added as an SVG
// turbulence filter, which Satori can't express; resvg (WebAssembly) rasterises it to PNG. Discord
// can't show SVG inline, so the PNG is what gets posted.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import satori from "satori";
import type { CatalogNames } from "../catalog.ts";
import type { MatchRecap, RecapPlayer } from "../recap.ts";
import { teamByAcs, teamResult } from "../recap.ts";
import type { RrState } from "./recapMessage.ts";
import { queueName } from "./recapMessage.ts";

/** Enhalation Mocha tokens (btw-arch-dots theme/enhalation/tokens.json, resolved). */
export const T = {
  ground: "#1e1e2e",
  groundSunken: "#181825",
  groundDeep: "#11111b",
  ink: "#cdd6f4",
  inkMuted: "#a6adc8",
  line: "#45475a",
  lineStrong: "#6c7086",
  accent: "#cba6f7",
  halo1: "#fab387",
  halo2: "#f5c2e7",
  halo3: "#cba6f7",
  spark: "#94e2d5",
  onHalo: "#11111b",
  glassFill: "#232334d6",
  glassFillStrong: "#232334eb",
  glassEdge: "#f5e0dc29",
  success: "#a6e3a1",
  successSoft: "#a6e3a11f",
  danger: "#f38ba8",
  dangerSoft: "#f38ba81f",
  glassFloat: "0 30px 60px -20px #08080de6, 0 12px 24px -12px #08080d99",
  haloGlow: "0 10px 34px -8px #cba6f780, 0 6px 22px -8px #fab38766",
  grain: 0.14,
} as const;

export const WIDTH = 1100;
// Satori sizes boxes the CSS default way (content-box): padding and borders sit outside a width.
const PAD = 48;
const BOARD_GAP = 18;
const BOARD_PAD = 18;
const BOARD_WIDTH = (WIDTH - 2 * PAD - BOARD_GAP) / 2 - 2 * BOARD_PAD - 2;
const FONT_DIR = process.env.FONT_DIR ?? "fonts";

export interface CardInput {
  recap: MatchRecap;
  tracked: string[];
  rr: Record<string, RrState>;
  names: CatalogNames | null;
  /** Riot IDs the bot knows (by PUUID), for players whose name Riot's match data leaves blank. */
  riotNames?: Record<string, string>;
  late?: boolean;
  /** Images as data URIs, fetched by loadArt. */
  art?: CardArt;
  timeZone?: string;
}

export interface CardArt {
  map: string | null;
  agents: Record<string, string>;
}

// ---------- fonts and wasm, loaded once ----------

type FontSpec = { name: string; data: ArrayBuffer; weight: 400 | 500 | 600 | 800; style: "normal" };
let fontsPromise: Promise<FontSpec[]> | null = null;
let wasmPromise: Promise<void> | null = null;

function fonts(): Promise<FontSpec[]> {
  fontsPromise ??= Promise.all(
    (
      [
        ["Bricolage", "BricolageGrotesque-ExtraBold.ttf", 800],
        ["Geist", "Geist-Regular.ttf", 400],
        ["Geist", "Geist-Medium.ttf", 500],
        ["Geist", "Geist-SemiBold.ttf", 600],
        ["Geist Mono", "GeistMono-Regular.ttf", 400],
        ["Geist Mono", "GeistMono-Medium.ttf", 500],
        ["Geist Mono", "GeistMono-SemiBold.ttf", 600],
      ] as const
    ).map(async ([name, file, weight]) => {
      const buf = await readFile(join(FONT_DIR, file));
      return { name, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, weight, style: "normal" as const };
    }),
  );
  return fontsPromise;
}

function wasm(): Promise<void> {
  wasmPromise ??= (async () => {
    const path = Bun.resolveSync("@resvg/resvg-wasm/index_bg.wasm", import.meta.dir);
    await initWasm(await readFile(path));
  })();
  return wasmPromise;
}

// ---------- images ----------

const imageCache = new Map<string, string | null>();

/** An image URL as a data URI, cached for the process; null if it can't be fetched. */
export async function fetchImage(url: string | undefined, fetchFn: typeof fetch = fetch): Promise<string | null> {
  if (!url) return null;
  if (imageCache.has(url)) return imageCache.get(url) ?? null;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(String(res.status));
    const type = res.headers.get("content-type") ?? "image/png";
    const data = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
    imageCache.set(url, data);
    return data;
  } catch {
    imageCache.set(url, null);
    return null;
  }
}

/** The map backdrop and every agent's icon in the match. Missing ones are left out, never fatal. */
export async function loadArt(recap: MatchRecap, names: CatalogNames | null, fetchFn: typeof fetch = fetch): Promise<CardArt> {
  const key = recap.mapId;
  const mapUrl = names?.mapArt?.[key] ?? names?.mapArt?.[key.toLowerCase()];
  const agentIds = [...new Set(recap.players.map((p) => p.agentId))];
  const [map, ...icons] = await Promise.all([fetchImage(mapUrl, fetchFn), ...agentIds.map((id) => fetchImage(names?.agentIcons?.[id], fetchFn))]);
  const agents: Record<string, string> = {};
  agentIds.forEach((id, i) => {
    const icon = icons[i];
    if (icon) agents[id] = icon;
  });
  return { map: map ?? null, agents };
}

// ---------- layout ----------

type Node = { type: string; props: Record<string, unknown> };
type Child = Node | string | null | false | undefined;

/** A Satori element. Every div with more than one child is a flex box. */
function el(type: string, style: Record<string, unknown>, ...children: Child[]): Node {
  const kids = children.filter((c): c is Node | string => c !== null && c !== false && c !== undefined);
  return { type, props: { style: { display: "flex", ...style }, children: kids.length === 1 ? kids[0] : kids } };
}

function img(src: string, style: Record<string, unknown>): Node {
  return { type: "img", props: { src, style } };
}

const mono = { fontFamily: "Geist Mono" };
const sans = { fontFamily: "Geist" };

function overline(text: string, color: string = T.inkMuted): Node {
  return el("div", { ...mono, fontSize: 15, fontWeight: 500, letterSpacing: 2.4, textTransform: "uppercase", color }, text);
}

function agentIcon(art: CardArt | undefined, p: RecapPlayer, size: number, radius: number): Node {
  const src = art?.agents[p.agentId];
  return src
    ? img(src, { width: size, height: size, borderRadius: radius, backgroundColor: T.groundSunken })
    : el("div", { width: size, height: size, borderRadius: radius, backgroundColor: T.line });
}

export function cardTree(input: CardInput): Node {
  const { recap, tracked, names, art } = input;
  const result = teamResult(recap, tracked);
  const map = recap.mapName ?? names?.maps[recap.mapId] ?? names?.maps[recap.mapId.toLowerCase()] ?? "Unknown map";
  const agentName = (p: RecapPlayer) => names?.agents[p.agentId] ?? "Agent";
  const rank = (tier: number) => names?.ranks[String(tier)] ?? `Tier ${tier}`;
  const riotName = (p: RecapPlayer) => p.riotName ?? input.riotNames?.[p.puuid] ?? null;
  const shortName = (p: RecapPlayer) => (riotName(p) ?? agentName(p)).split("#")[0] as string;
  const kda = (p: RecapPlayer) => (p.kills === null ? "—" : `${p.kills}/${p.deaths}/${p.assists}`);
  const topAcs = Math.max(...recap.players.map((p) => p.acs ?? -1));

  const word = !result ? "MATCH" : result.kind === "victory" ? "VICTORY" : result.kind === "defeat" ? "DEFEAT" : result.kind === "draw" ? "DRAW" : "SPLIT";
  // The warm core is the one big moment: a win. A loss reads in danger, a draw or split on glass.
  const pill =
    result?.kind === "victory"
      ? { backgroundImage: `linear-gradient(135deg, ${T.halo1}, ${T.halo2})`, color: T.onHalo, boxShadow: T.haloGlow }
      : result?.kind === "defeat"
        ? { backgroundColor: T.dangerSoft, color: T.danger, border: `1px solid ${T.danger}55` }
        : { backgroundColor: T.glassFill, color: T.ink, border: `1px solid ${T.glassEdge}` };

  const when = new Date(recap.startedAt).toLocaleString("en-GB", { timeZone: input.timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  // ---- header ----
  const header = el(
    "div",
    { flexDirection: "column", gap: 10 },
    el("div", { alignItems: "center", gap: 20 },
      el("div", { ...mono, fontSize: 22, fontWeight: 600, letterSpacing: 3, padding: "10px 22px", borderRadius: 18, ...pill }, word),
      result ? el("div", { fontFamily: "Bricolage", fontWeight: 800, fontSize: 84, lineHeight: 1, color: T.ink, letterSpacing: -2 }, result.score) : null,
    ),
    el("div", { alignItems: "baseline", gap: 16, marginTop: 4 },
      el("div", { fontFamily: "Bricolage", fontWeight: 800, fontSize: 46, color: T.ink, letterSpacing: -1 }, map),
      el("div", { ...sans, fontSize: 22, color: T.inkMuted }, [queueName(recap.queue), recap.lengthMinutes ? `${recap.lengthMinutes} min` : "", when].filter(Boolean).join("  ·  ")),
    ),
  );

  // ---- tracked players: one glass row each ----
  const trackedPlayers = recap.players.filter((p) => tracked.includes(p.puuid)).sort((a, b) => (b.acs ?? -1) - (a.acs ?? -1));
  const stat = (label: string, value: string, width: number) =>
    el("div", { flexDirection: "column", width, gap: 2 }, overline(label), el("div", { ...mono, fontSize: 28, fontWeight: 500, color: T.ink }, value));
  const playerRows = trackedPlayers.map((p) => {
    const rr = input.rr[p.puuid];
    const rrBox =
      rr && rr !== "none" && rr !== "pending"
        ? el("div", { flexDirection: "column", alignItems: "flex-end", gap: 2, marginLeft: "auto", width: 150 },
            el("div", { ...mono, fontSize: 30, fontWeight: 600, color: rr.earned >= 0 ? T.success : T.danger }, `${rr.earned >= 0 ? "+" : "−"}${Math.abs(rr.earned)} RR`),
            el("div", { ...sans, fontSize: 18, color: T.inkMuted }, `${rank(rr.tierAfter)} · ${rr.after}`),
          )
        : rr === "pending"
          ? el("div", { ...mono, fontSize: 20, color: T.inkMuted, marginLeft: "auto" }, "RR …")
          : el("div", { marginLeft: "auto" });
    const name = riotName(p);
    return el(
      "div",
      { alignItems: "center", gap: 18, padding: "18px 24px", borderRadius: 26, backgroundColor: T.glassFill, border: `1px solid ${T.glassEdge}`, boxShadow: T.glassFloat },
      agentIcon(art, p, 64, 16),
      el("div", { flexDirection: "column", width: 220, gap: 2 },
        el("div", { ...sans, fontSize: 26, fontWeight: 600, color: T.ink }, name ? (name.split("#")[0] as string) : agentName(p)),
        el("div", { ...sans, fontSize: 18, color: T.inkMuted }, name?.includes("#") ? `#${name.split("#")[1]} · ${agentName(p)}` : agentName(p)),
      ),
      stat("K / D / A", kda(p), 150),
      stat("ACS", p.acs === null ? "—" : String(p.acs), 80),
      stat("HS", p.hsPercent === null ? "—" : `${p.hsPercent}%`, 70),
      stat("ADR", p.adr === null ? "—" : String(p.adr), 70),
      rrBox,
    );
  });

  // ---- scoreboards: the tracked team first ----
  const teamIds = recap.teams.map((t) => t.teamId);
  const ours = result && result.kind !== "split" ? result.teamId : null;
  const ordered = ours ? [ours, ...teamIds.filter((t) => t !== ours)] : teamIds;
  const board = (teamId: string, i: number) => {
    const team = recap.teams.find((t) => t.teamId === teamId);
    const label = ours ? (i === 0 ? "Your team" : "Enemy team") : `Team ${teamId}`;
    return el(
      "div",
      { flexDirection: "column", width: BOARD_WIDTH, gap: 6, padding: `20px ${BOARD_PAD}px`, borderRadius: 26, backgroundColor: T.glassFillStrong, border: `1px solid ${T.glassEdge}` },
      el("div", { justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
        overline(label),
        el("div", { ...mono, fontSize: 18, fontWeight: 600, color: team?.won ? T.success : T.inkMuted }, team ? `${team.roundsWon} rounds` : ""),
      ),
      ...teamByAcs(recap, teamId).map((p) => {
        const isTracked = tracked.includes(p.puuid);
        const isTop = p.acs !== null && p.acs === topAcs;
        return el(
          "div",
          { alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 12, backgroundColor: isTracked ? "#cba6f71a" : "transparent" },
          el("div", { width: 4, height: 28, borderRadius: 2, backgroundColor: isTracked ? T.accent : "transparent" }),
          agentIcon(art, p, 32, 8),
          el("div", { ...sans, fontSize: 20, fontWeight: isTracked ? 600 : 400, color: isTracked ? T.accent : T.ink, width: 150, overflow: "hidden", whiteSpace: "nowrap" }, shortName(p).slice(0, 14)),
          el("div", { ...mono, fontSize: 20, color: T.inkMuted, width: 104 }, kda(p)),
          el("div", { ...mono, fontSize: 20, fontWeight: 600, color: T.ink, width: 48, justifyContent: "flex-end" }, p.acs === null ? "—" : String(p.acs)),
          // The one spark per view: the match's top ACS.
          el("div", { width: 10, height: 10, borderRadius: 9999, marginLeft: 4, backgroundColor: isTop ? T.spark : "transparent" }),
        );
      }),
    );
  };

  const footer = el(
    "div",
    { justifyContent: "space-between", marginTop: 4 },
    overline(`daily-drip · match ${recap.matchId.slice(0, 8)}${input.late ? " · late" : ""}`, T.lineStrong),
    el("div", { alignItems: "center", gap: 8 }, el("div", { width: 10, height: 10, borderRadius: 9999, backgroundColor: T.spark }), overline("top ACS", T.lineStrong)),
  );

  return el(
    "div",
    {
      width: WIDTH - 2 * PAD,
      flexDirection: "column",
      // The ground and the map backdrop are drawn underneath by compose(): Satori paints absolute
      // children above their siblings, which washed out the header.
      // The Halo: warm core top-left (peach, pink), the mauve bleed, and the cool teal counter-glow.
      backgroundImage: [
        `radial-gradient(circle at 8% 0%, ${T.halo1}55 0%, transparent 38%)`,
        `radial-gradient(circle at 30% 6%, ${T.halo2}40 0%, transparent 34%)`,
        `radial-gradient(circle at 52% 0%, ${T.halo3}38 0%, transparent 40%)`,
        `radial-gradient(circle at 100% 100%, ${T.spark}1f 0%, transparent 38%)`,
      ].join(", "),
      padding: PAD,
      gap: 22,
      position: "relative",
    },
    header,
    ...playerRows,
    el("div", { gap: BOARD_GAP }, ...ordered.slice(0, 2).map(board)),
    footer,
  );
}

const BACKDROP_HEIGHT = 340;

/**
 * The final SVG, bottom to top: the ground, the map's splash faded into it, Satori's card, and the
 * grain (Enhalation's grain.svg: feTurbulence .85, 3 octaves, stitched) over everything.
 */
function compose(card: string, width: number, height: number, map: string | null): string {
  const inner = card.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const backdrop = map
    ? `<image href="${map}" x="0" y="0" width="${width}" height="${BACKDROP_HEIGHT}" preserveAspectRatio="xMidYMid slice" opacity="0.24"/>` +
      `<linearGradient id="dd-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.ground}" stop-opacity="0.1"/><stop offset="1" stop-color="${T.ground}" stop-opacity="1"/></linearGradient>` +
      `<rect width="${width}" height="${BACKDROP_HEIGHT}" fill="url(#dd-fade)"/>`
    : "";
  const grain =
    `<filter id="dd-grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/>` +
    `<feColorMatrix type="saturate" values="0"/></filter>` +
    `<rect width="${width}" height="${height}" filter="url(#dd-grain)" opacity="${T.grain}" style="mix-blend-mode:overlay"/>`;
  return (
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
    `<rect width="${width}" height="${height}" fill="${T.ground}"/>${backdrop}<g>${inner}</g>${grain}</svg>`
  );
}

/** The card as SVG (for tests and previews) and as PNG (for Discord). */
export async function renderRecapCard(input: CardInput, scale = 1): Promise<{ svg: string; png: Uint8Array; height: number }> {
  const [loadedFonts] = await Promise.all([fonts(), wasm()]);
  const tree = cardTree(input);
  // Satori needs a height: measure first at a generous one, then trim to the content.
  const svg0 = await satori(tree as never, { width: WIDTH, fonts: loadedFonts });
  const height = Number(svg0.match(/height="(\d+(?:\.\d+)?)"/)?.[1] ?? 900);
  const svg = compose(svg0, WIDTH, height, input.art?.map ?? null);
  const png = new Resvg(svg, { fitTo: { mode: "zoom", value: scale }, background: T.ground }).render().asPng();
  return { svg, png, height };
}
