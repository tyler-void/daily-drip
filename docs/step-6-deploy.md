# Step 6: Docker and deploy to `home-server`

How the bot is deployed, what was checked, and what is still open. The spec, `Valorant Store Checker — Spec.md`, stays the source of truth for behaviour.

## How it is deployed

- **From the dev machine:** `DEPLOY_HOST=home-server scripts/deploy.sh`. It copies `src/` and the build files to `~/daily-drip` with `rsync -rlt`, builds `daily-drip:local` on the server and runs `docker compose up -d`. The server needs no GitHub access.
- **On the server, `~/daily-drip`** (mode 750) holds, besides the synced files:
  - `.env` (mode 600): the four `DISCORD_` values, `TZ`, and optionally `HEALTHCHECK_URL`, `LOG_LEVEL` and `RIOT_SHARD`. Compose reads it to fill `${VAR}` in `compose.yaml`.
  - `config/` (mode 700): `riot-cookie` (mode 600, one line holding the whole `cookie` request header). Mounted read-only at `/app/config`. An optional `config/wishlist.json`, a JSON array such as `["Reaver", "Prime Vandal"]`, is imported once on the first start.
- **State** lives in the named volume `daily-drip_daily-drip-data` (`/app/data`): `state.json` with the rotated cookies, and the catalog cache.
- **The container** has no ports, a read-only root filesystem, no capabilities, `no-new-privileges`, 256 MB, 128 processes and capped logs. It runs as the image's `bun` user, uid 1000, which is also the server user that owns `config/`.

The script never touches `.env`, `config/` or the volume, and it starts nothing until `.env` and `config/riot-cookie` exist.

## Rules

- **The server's cookie is its own sign-in,** never the dev PC's. Two machines sharing one cookie split its rotation, and one copy dies. The steps are in the spec (Auth flow, "Getting the cookie the first time").
- **The server's Discord bot is its own application,** separate from the dev bot. If it is not in the server yet, the bot logs its invite link at startup and exits. Never run two processes with the same bot token, or two with the same cookie.
- **Never copy** the dev PC's `data/` or `config/` to the server.
- To change a variable, edit `.env` and run `docker compose up -d` (a `docker restart` does not re-read it). To replace the cookie, overwrite the file; the bot notices within a minute.
- Keep `oven/bun` in the `Dockerfile` at the version used for development.

## Health check (optional, recommended)

healthchecks.io: one check, period 1 day, grace 2 hours, ping URL in `HEALTHCHECK_URL`. It catches what the bot cannot report itself: the container or the machine being down.

## Checked on 2026-11-23

- `oven/bun:1.3.14-slim` has the `bun` user as uid 1000 and time zone data, so `TZ` gives local log times.
- In that image: `bun test` (148 pass) and `bun run typecheck`.
- The locked-down container starts, writes `state.json` (mode 600, uid 1000) to a fresh volume, and stops with a clear message on a bad Discord token.
- **Cloudflare, from `home-server`, in the container image, without a cookie:** `scripts/spike.ts --probe` ended with "PROBE OK" (303 to the login page). Bun's TLS gets through from the server too.

## First start, 2026-11-23

- The container logged in to Riot from `home-server` on its first run, refreshed the catalog, posted the shop and scheduled the next run for 90 s after the next reset.
- A `docker restart` the same day logged "this shop was already sent; nothing to post".
- Secret scan: `docker logs daily-drip 2>&1 | grep -nE 'ssid=[^[]|Bearer [^[]|eyJ'` printed nothing, and the bot token does not appear in the logs.

## Acceptance still open (spec: Acceptance criteria, on `home-server`)

1. A `/wishlist` entry survives a restart and pings when its skin is in the shop. (`/shop` from another account was refused, checked by the owner on 2026-11-23.)
2. The automatic post after the next reset, a failed run at reset time being retried, and still working on day 3.
3. Run the secret scan above once more at the end.
4. **The broken-cookie test goes last.** Changing one character in the cookie file makes the bot replace its saved session with the broken one, so the working session is gone afterwards. Expect exactly one "cookie expired" ping and no retry loop. Then a fresh cookie goes into the file and the bot recovers within about a minute.

## Things learned in steps 1–5 (also in the spec)

- A dead cookie now redirects E1 to `authenticate.riotgames.com/login`; SkinPeek's relative `/login` check alone misses it.
- SkinPeek's real User-Agent is `ShooterGame/13 Windows/10.0.19043.1.256.64bit`; the `RiotClient/…` line in its code never runs.
- `expiresAt` moves by about a second between fetches (one run saw 23:59:59.505, the next 00:00:00.340); the dedup hash rounds it to 10 minutes.
- A Discord bot that was never invited fails with "Unknown Guild" (10004); the startup check catches it and logs the invite link.
- Never paste cookies or tokens into chat, Discord or logs. `src/log.ts` redacts; keep all output going through it.
