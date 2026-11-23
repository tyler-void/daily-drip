// Entry point. Build step 2: one auth pass, which also rotates and saves the cookie jar.
// Step 3 adds the store, step 4 the Discord bot, step 5 the scheduler.

import { loadConfig } from "./config.ts";
import { createHttp, NetworkError } from "./http.ts";
import { log } from "./log.ts";
import { authenticate, CloudflareBlockedError, CookieDeadError, RateLimitedError } from "./riot/auth.ts";
import { loadState, saveState } from "./state.ts";

const config = loadConfig();
const state = await loadState();

try {
  const session = await authenticate({
    http: createHttp(),
    state,
    save: (s) => saveState(s),
    cookieFile: config.RIOT_COOKIE_FILE,
    shardOverride: config.RIOT_SHARD,
  });
  log.info("authenticated", { shard: session.shard, puuid: `${session.puuid.slice(0, 8)}…` });
} catch (err) {
  if (err instanceof CookieDeadError) {
    log.error(`cookie dead: ${err.message}. Put a fresh cookie header in ${config.RIOT_COOKIE_FILE}.`);
  } else if (err instanceof CloudflareBlockedError) {
    log.error(`blocked: ${err.message}. See the TLS fallback in the spec (Endpoints, TLS).`);
  } else if (err instanceof RateLimitedError || err instanceof NetworkError) {
    log.error(err.message);
  } else {
    log.error("authentication failed", { error: err });
  }
  process.exitCode = 1;
}
