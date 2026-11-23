// data/state.json (spec: Storage & secrets). Mode 0600, written atomically via temp file + rename.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CookieJar } from "./cookies.ts";
import { log } from "./log.ts";

export interface State {
  version: 1;
  /** Riot's latest rotated cookies, and the hash of the cookie-file contents they started from. */
  cookie: { jar: CookieJar; sourceHash: string } | null;
  puuid: string | null;
  shard: string | null;
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
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {}); // does nothing on Windows
  await renameWithRetry(tmp, path);
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

// On Windows, replacing a file that an antivirus scanner or the indexer has open
// fails briefly with EPERM, EBUSY or EACCES.
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const retryable = ["EPERM", "EBUSY", "EACCES"].includes(errorCode(err) ?? "");
      if (!retryable || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
}
