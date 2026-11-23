# Step 6: Docker and deploy to `home-server`

Handoff for the agent working on `home-server` (Linux, Docker, Portainer). Read the spec, `Valorant Store Checker — Spec.md`, first; this note adds what the spec does not say and what steps 1–5 taught.

## Where things stand

- Steps 1–5 are done on branch `dev`, built and tested on the owner's Windows PC against the real account and a dev Discord bot (`daily-drip-dev`).
- `main` is what Portainer deploys. **Merge `dev` into `main` only with the owner's OK.**
- Verified on the dev PC (Bun 1.3.14, discord.js 14.28.1): Riot's Cloudflare lets Bun through; login (E1–E4), the shop (E6), prices inside E6, catalog, Discord embeds, `/shop`, `/wishlist`, the duplicate check across restarts, and the scheduler arming the next run for reset + 90 s.
- **Not yet verified anywhere:** the same from `home-server` and inside the container (TLS, IP, discord.js), the automatic post after a reset, a real cookie expiry.
- Checks: `bun install`, `bun test` (147 pass, 1 Windows-only skip), `bun run typecheck`.

## Deliverables

### 1. `Dockerfile`

- `FROM oven/bun:1.3.14-slim`. This pins the dev PC's version. Check that the tag exists; if you move to a newer Bun, the owner should update the dev PC to the same version.
- `WORKDIR /app`; copy `package.json` and `bun.lock`; run `bun install --frozen-lockfile --production`; copy `src/`. Bun runs TypeScript directly, so there is no build stage, and `tsconfig.json`, `test/`, `scripts/` and `docs/` are not needed in the image.
- Before `USER bun`, run `mkdir -p /app/data /app/config && chown bun:bun /app/data`. A new named volume copies the image directory's ownership; without this the volume is root-owned and the bot cannot write `state.json`. Check that the image really has a `bun` user with uid 1000: `docker run --rm oven/bun:1.3.14-slim id bun`.
- `CMD ["bun", "src/main.ts"]`. The bot handles SIGTERM and closes the Discord connection cleanly.

### 2. `.dockerignore`

`.env`, `.env.*`, `config/`, `data/`, `node_modules/`, `test/`, `scripts/`, `docs/`, `.git/`, `*.md`. The first three hold secrets. Bun loads a `.env` from the working directory by itself, so none may reach the image.

### 3. `compose.yaml`

```yaml
services:
  daily-drip:
    build: .
    container_name: daily-drip
    restart: unless-stopped
    environment:
      DISCORD_TOKEN: ${DISCORD_TOKEN}
      DISCORD_GUILD_ID: ${DISCORD_GUILD_ID}
      DISCORD_CHANNEL_ID: ${DISCORD_CHANNEL_ID}
      DISCORD_OWNER_ID: ${DISCORD_OWNER_ID}
      RIOT_COOKIE_FILE: /app/config/riot-cookie
      RIOT_SHARD: ${RIOT_SHARD:-}
      LOG_LEVEL: ${LOG_LEVEL:-info}
      HEALTHCHECK_URL: ${HEALTHCHECK_URL:-}
      TZ: ${TZ:-UTC}
    volumes:
      - daily-drip-data:/app/data
      - /opt/daily-drip/config:/app/config:ro
volumes:
  daily-drip-data:
```

- There is no `env_file`: `.env` is gitignored, so a stack deployed from Git never sees it. Portainer fills `${VAR}` from the stack's Environment variables.
- Empty values are fine: `src/config.ts` treats an empty variable as unset.
- `TZ` only changes log timestamps. Check that the logs show local time; if the slim image lacks time zone data, logs stay in UTC, which is harmless.

### 4. Server setup

```sh
sudo mkdir -p /opt/daily-drip/config
sudo chown 1000:1000 /opt/daily-drip/config
sudo chmod 700 /opt/daily-drip/config
```

- **The cookie file** is `/opt/daily-drip/config/riot-cookie`: mode 600, owned by 1000:1000, one line holding the whole `cookie` request header. **The owner provides it.** It must be a *new* sign-in, not the dev PC's cookie: two machines sharing one cookie split its rotation, and one copy dies. The steps are in the spec (Auth flow, "Getting the cookie the first time"). The bot only reads this file; the rotated cookies go to `state.json` in the volume.
- **Optional:** `/opt/daily-drip/config/wishlist.json`, a JSON array such as `["Reaver", "Prime Vandal"]`, is imported once on the first start. Otherwise the owner uses `/wishlist add`.
- **Never copy** the dev PC's `data/` or `config/` to the server. The server starts with an empty `data/`.

### 5. Production Discord bot

A second Discord application, for example `daily-drip`, separate from `daily-drip-dev`. Steps are in the spec (Storage & secrets, the Discord rows, and "Inviting the bot"). If it is not in the server yet, the bot logs its invite link at startup and exits, with the permission value `19456` already filled in. Use a production channel; it may be in the same server as the dev bot. Never run two processes with the same bot token, or two with the same cookie.

### 6. Portainer stack

1. While the repo is private: GitHub → Settings → Developer settings → fine-grained token, only `tyler-void/daily-drip`, **Contents: Read-only**.
2. Portainer → Stacks → Add stack → Repository: `https://github.com/tyler-void/daily-drip`, reference `refs/heads/main`, compose path `compose.yaml`, authentication with that token while the repo is private.
3. Environment variables: the four `DISCORD_` values, plus `HEALTHCHECK_URL`, `LOG_LEVEL` and `RIOT_SHARD` if wanted.
4. Check that Portainer builds `build: .` for this environment. If it does not, build from a clone on the host with `docker compose up -d --build`, giving the same variables through a `.env` next to `compose.yaml`. That `.env` is gitignored; keep it mode 600.

To change a variable, redeploy the stack (`docker restart` does not re-read variables). To replace the cookie, overwrite the file; the bot notices within a minute, with no redeploy.

### 7. Health check (optional, recommended)

healthchecks.io: one check, period 1 day, grace 2 hours, ping URL in `HEALTHCHECK_URL`. It catches what the bot cannot report itself: the container or the machine being down.

## Acceptance (spec: Acceptance criteria, run on `home-server`)

1. **Cloudflare check first, without a cookie:** from a clone on the host, run `docker run --rm -v "$PWD":/app -w /app oven/bun:1.3.14-slim bun scripts/spike.ts --probe`. It should end with "PROBE OK". If it prints "blocked", the spec's TLS fallback (Endpoints, TLS) is next.
2. Start the stack. The logs should show "connected to Discord", then "shop posted" (or "already sent"), then "next run scheduled" for about 90 s after the next reset.
3. Work through the spec's checklist: `/shop`, `/wishlist`, restart posts nothing new, the automatic post after the next reset, still working on day 3.
4. Secret scan: `docker logs daily-drip 2>&1 | grep -nE 'ssid=[^[]|Bearer [^[]|eyJ'` must print nothing.
5. **The broken-cookie test goes last.** Changing one character in the cookie file makes the bot replace its saved session with the broken one, so the working session is gone afterwards. Expect exactly one "cookie expired" ping and no retry loop. Then the owner pastes a fresh cookie and the bot recovers within about a minute.

## Things learned in steps 1–5 (also in the spec)

- A dead cookie now redirects E1 to `authenticate.riotgames.com/login`; SkinPeek's relative `/login` check alone misses it.
- SkinPeek's real User-Agent is `ShooterGame/13 Windows/10.0.19043.1.256.64bit`; the `RiotClient/…` line in its code never runs.
- `expiresAt` moves by about a second between fetches (one run saw 23:59:59.505, the next 00:00:00.340); the dedup hash rounds it to 10 minutes.
- A Discord bot that was never invited fails with "Unknown Guild" (10004); the startup check catches it and logs the invite link.
- Never paste cookies or tokens into chat, Discord or logs. `src/log.ts` redacts; keep all output going through it.
