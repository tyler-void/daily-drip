// Entry point. Build step 3: one shop run, printed to the log and saved in state.
// Step 4 adds the Discord bot, step 5 the scheduler.

import { loadConfig } from "./config.ts";
import { createHttp, NetworkError } from "./http.ts";
import { log } from "./log.ts";
import { CloudflareBlockedError, CookieDeadError, RateLimitedError, UnexpectedResponseError } from "./riot/auth.ts";
import { BadClaimsError, MaintenanceError } from "./riot/store.ts";
import { fetchShop } from "./shop.ts";
import { loadState, saveState } from "./state.ts";

const config = loadConfig();
const state = await loadState();

try {
  const snapshot = await fetchShop({
    http: createHttp(),
    state,
    save: (s) => saveState(s),
    cookieFile: config.RIOT_COOKIE_FILE,
    shardOverride: config.RIOT_SHARD,
  });
  const resetsIn = Math.max(0, Date.parse(snapshot.expiresAt) - Date.now()) / 60_000;
  log.info("today's shop", { resetsAt: snapshot.expiresAt, resetsIn: `${Math.floor(resetsIn / 60)}h ${Math.floor(resetsIn % 60)}m` });
  for (const offer of snapshot.offers) {
    log.info(`  ${offer.name}`, { vp: offer.vp, tier: offer.tier?.name ?? null, icon: offer.iconUrl !== null });
  }
} catch (err) {
  if (err instanceof CookieDeadError) {
    log.error(`cookie dead: ${err.message}. Put a fresh cookie header in ${config.RIOT_COOKIE_FILE}.`);
  } else if (err instanceof CloudflareBlockedError) {
    log.error(`blocked: ${err.message}. See the TLS fallback in the spec (Endpoints, TLS).`);
  } else if (err instanceof MaintenanceError || err instanceof BadClaimsError || err instanceof RateLimitedError) {
    log.error(err.message);
  } else if (err instanceof NetworkError || err instanceof UnexpectedResponseError) {
    log.error(`run failed: ${err.message}`);
  } else {
    log.error("run failed", { error: err });
  }
  process.exitCode = 1;
}
