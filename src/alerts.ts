// Alert texts (spec: Error handling). Sent through the Notifier, which pings the owner.

import { REAUTH_URL } from "./riot/auth.ts";

const HOUR = 3_600_000;

/** The steps to replace a dead cookie (spec: Auth flow, manual step). */
export function cookieDeadText(cookieFile: string): string {
  return [
    "**Riot cookie expired.** The shop can't be fetched until it is replaced:",
    "1. In an Edge InPrivate window, sign in at https://auth.riotgames.com.",
    "2. Press F12 → Network (tick Preserve log, filter All), then open this link in the same tab:",
    `<${REAUTH_URL}>`,
    "3. Click the first `authorize` request → Request Headers → right-click `cookie` → Copy value.",
    `4. On the bot's machine, overwrite the cookie file (\`${cookieFile}\` as the bot sees it) with that value. The bot notices within a minute; no restart needed.`,
    "5. Close the window without signing out.",
  ].join("\n");
}

export function blockedText(reason: string): string {
  return (
    `**Riot blocked the login** from this machine (${reason}). I'll retry every hour. ` +
    "If it keeps happening from your home connection, the next step is the TLS fallback in the spec (Endpoints, TLS)."
  );
}

export const BAD_CLAIMS_TEXT =
  "**Riot rejected fresh tokens twice** (BAD_CLAIMS). The cookie itself still works, so this points to a header or shard problem. " +
  "I'll keep retrying every 30 minutes.";

export function deadManText(sinceMs: number, lastError: string | null): string {
  const hours = Math.floor(sinceMs / HOUR);
  const why = lastError ? ` The last error was: ${lastError}` : "";
  return `**No shop for ${hours} hours:** no run has succeeded in that time.${why} I'll keep retrying.`;
}
