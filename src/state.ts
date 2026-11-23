// data/state.json (spec: Storage & secrets). Mode 0600, written atomically via temp file + rename.

import { readFile, rename } from "node:fs/promises";
import type { CookieJar } from "./cookies.ts";
import { errorCode, writeFileAtomic } from "./files.ts";
import { log } from "./log.ts";
import type { ShopSnapshot } from "./shop.ts";

export interface State {
  version: 1;
  /** Riot's latest rotated cookies, and the hash of the cookie-file contents they started from. */
  cookie: { jar: CookieJar; sourceHash: string } | null;
  puuid: string | null;
  shard: string | null;
  /** The latest shop; `/shop` answers from it while it has not expired. */
  snapshot: ShopSnapshot | null;
  lastSentHash: string | null;
  lastSuccessAt: string | null;
  flags: {
    cookieDeadNotified: boolean;
    blockedNotified: boolean;
    deadManNotified: boolean;
  };
}

export const DEFAULT_STATE_FILE = "data/state.json";
export const SPIKE_JAR_FILE = "data/spike-jar.json";

export function emptyState(): State {
  return {
    version: 1,
    cookie: null,
    puuid: null,
    shard: null,
    snapshot: null,
    lastSentHash: null,
    lastSuccessAt: null,
    flags: { cookieDeadNotified: false, blockedNotified: false, deadManNotified: false },
  };
}

export async function loadState(path = DEFAULT_STATE_FILE): Promise<State> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return emptyState();
    throw err;
  }
  try {
    const saved = JSON.parse(raw) as Partial<State>;
    const empty = emptyState();
    return { ...empty, ...saved, flags: { ...empty.flags, ...saved.flags } };
  } catch {
    // Atomic writes make this unlikely. Keep the bad file for inspection and fall back to the cookie file.
    const aside = `${path}.corrupt-${Date.now()}`;
    await rename(path, aside);
    log.warn("state file was not valid JSON; moved it aside and starting from the cookie file", { movedTo: aside });
    return emptyState();
  }
}

export async function saveState(state: State, path = DEFAULT_STATE_FILE): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(state, null, 2), 0o600);
}

/**
 * One-time import of the spike's rotated jar, so the first real run does not fall back
 * to the older pasted cookie. Only when the state has no jar yet and the spike started
 * from the same cookie file. The spike file is renamed afterwards so it is not reused.
 */
export async function importSpikeJar(state: State, sourceHash: string, spikePath = SPIKE_JAR_FILE): Promise<boolean> {
  if (state.cookie) return false;
  let saved: { sourceHash?: unknown; jar?: unknown };
  try {
    saved = JSON.parse(await readFile(spikePath, "utf8"));
  } catch {
    return false;
  }
  if (saved.sourceHash !== sourceHash || typeof saved.jar !== "object" || saved.jar === null) return false;
  state.cookie = { jar: saved.jar as CookieJar, sourceHash };
  await rename(spikePath, `${spikePath}.imported`);
  return true;
}
