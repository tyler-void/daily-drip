# Valorant Store Checker — Spec

Nov 23, 2026

## Goal & scope

After every shop reset, a Discord bot on `home-server` fetches the owner's 4 daily Valorant skins and posts them to a private Discord channel with name, image and VP price; the Discord app pushes them to his phone. It is read-only and needs neither the game nor the Riot Client running, on the server or on the development PC.

**MVP**

- Fetch the daily shop (4 skins) after each reset and send one message.
- Wishlist: when a wishlisted skin appears, send an extra message that pings the owner.
- When the cookie dies, notify exactly once with instructions to replace it.
- `/shop` slash command: shows the current shop on demand, from the cached snapshot.

**After MVP**

- Night Market, Accessory store, featured bundle.

**Non-goals**

- Multiple users: one account, the owner's.
- Username/password login: that flow is behind hCaptcha.
- Purchases or any write request to Riot.
- Touching the game client.

## Decisions

Cookie reauth, run in Docker on `home-server`, written in TypeScript, notifications via a Discord bot. The last column says which choices can change without touching the rest.

| Area | Default | Why | Changeable? |
| --- | --- | --- | --- |
| Auth | Cookie reauth (full cookie header, or `ssid` alone) | No password, no captcha | No: every other route is worse |
| Host | `home-server`, Docker container (Portainer stack) | Residential IP; Riot's Cloudflare often blocks VPS/cloud IPs | Another home machine yes; avoid VPS |
| Runtime | TypeScript on Bun, same version on the dev PC and in the Dockerfile | Runs TypeScript directly (no build step), built-in test runner and `.env` loading | Yes: Node 24 if the TLS spike fails under Bun. Bun-only APIs stay in `http.ts`, so switching touches one file |
| Notifications | Discord bot (discord.js) posting in a private server | Phone push via the Discord app; 4 embeds with image, name and price in one message; slash commands; the gateway connection is outbound-only, so no open ports | Yes: behind a `Notifier` interface (Telegram, ntfy) |
| Schedule | Arm from `...RemainingDurationInSeconds` + 90 s | No hardcoded reset time | No |
| Repo | Private on GitHub: `tyler-void/daily-drip` | Uses unofficial endpoints and handles account cookies | Yes |

Reference implementations: [SkinPeek](https://github.com/giorgi-o/SkinPeek) (archived 2025-06-04) and [exoflex6/Storefront](https://github.com/exoflex6/Storefront) (its single-user replacement, same flow). Read their code when this spec is silent on a detail.

## Auth flow

Each run trades a Riot session cookie for a fresh access token; no password is ever needed. The order of steps is checked against SkinPeek's `valorant/auth.js` and the Storefront README. E-numbers refer to the Endpoints table.

1. Load the cookie jar from `data/state.json`. On first run, or when the cookie file's hash differs from the one stored with the jar, load the jar from the cookie file instead (Storage & secrets).
2. Call reauth (E1) **without following redirects**.
   - 303 with `Location` containing `#access_token=…`: parse `access_token` and `id_token` from the URL fragment.
   - `Location` pointing to the login page: the cookie is dead; take the "cookie dead" path in Error handling. On 2026-11-23 that page was `https://authenticate.riotgames.com/login`. SkinPeek only checks for a relative `/login`, which no longer matches, so accept both.
   - 403, or no token in the fragment: blocked by Cloudflare; see Error handling.
3. Merge every `Set-Cookie` from the response into the jar and **persist state immediately** (atomic write). Riot rotates cookies on each reauth; skipping this kills the cookie early.
4. Get the entitlements token (E2).
5. Get the PUUID from the `sub` field of userinfo (E3); cache it in state.
6. Get the region from `affinities.live` (E4) and map it to a shard: `latam` and `br` use `na`; any other value is the shard itself (SkinPeek's `userRegion`). Cache it in state. `RIOT_SHARD` overrides it. Code must not assume a particular shard.
7. Tokens live about 1 hour ([valapidocs](https://techchrism.github.io/valorant-api-docs/common-components.html)). Reauth from scratch on every run; never keep tokens between runs.

**Getting the cookie the first time (manual):** sign in at auth.riotgames.com in a Chromium-based browser. Open DevTools → Network, pick any request to auth.riotgames.com, right-click the `cookie` request header → Copy value, and paste it into the cookie file. The [SkinPeek wiki](https://github.com/giorgi-o/SkinPeek/wiki/How-to-get-your-Riot-cookies) says Firefox truncates long cookies, so do not use LibreWolf for this step.

## Endpoints & headers

The storefront is now **v3, POST with body `{}`**. valapidocs still documents v2 GET, but both SkinPeek and Storefront call v3. Every row comes from SkinPeek's source (`valorant/auth.js`, `shop.js`, `cache.js`) unless noted.

| # | Method | URL | Headers / body | Returns |
| --- | --- | --- | --- | --- |
| E1 | GET | `https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&scope=account%20openid&nonce=1` | `Cookie`, `User-Agent` (below); do not follow redirects | 303; `access_token` + `id_token` in the `Location` fragment; rotated cookies in `Set-Cookie` |
| E2 | POST | `https://entitlements.auth.riotgames.com/api/token/v1` | `Authorization: Bearer <access_token>`, `Content-Type: application/json` | `entitlements_token` |
| E3 | GET | `https://auth.riotgames.com/userinfo` | Bearer | `sub` = PUUID |
| E4 | PUT | `https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant` | Bearer; body `{"id_token": "<id_token>"}` | `affinities.live` = shard |
| E5 | GET | `https://valorant-api.com/v1/version` | none | `data.riotClientVersion`, `data.riotClientBuild` |
| E6 | POST | `https://pd.{shard}.a.pvp.net/store/v3/storefront/{puuid}` | 4 game headers (below); body `{}` | Daily shop, Night Market, Accessory store |
| E7 | GET | `https://pd.{shard}.a.pvp.net/store/v1/offers/` | 4 game headers | `Offers[].OfferID` → `Cost` (prices); fallback only, see Data mapping |
| E8 | GET | `https://valorant-api.com/v1/weapons` | none | Skin names, images, levels |
| E9 | GET | `https://valorant-api.com/v1/contenttiers` | none | Tier names and colours |

**4 game headers** (E6, E7):

- `Authorization: Bearer <access_token>`
- `X-Riot-Entitlements-JWT: <entitlements_token>`
- `X-Riot-ClientVersion: <riotClientVersion from E5>`. Fetch E5 at the start of every run, and again when E6 fails after a game update.
- `X-Riot-ClientPlatform`: the constant below. It is base64 of the JSON `{platformType: PC, platformOS: Windows, platformOSVersion: 10.0.19042.1.256.64bit, platformChipset: Unknown}`, tab-indented, with `\r\n` line breaks. Recomputed here; it matches SkinPeek.

```text
ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9
```

**User-Agent for E1:** `ShooterGame/13 Windows/10.0.19043.1.256.64bit`. This is what SkinPeek actually sends: its `getUserAgent` (`valorant/auth.js`) returns this value early, with a comment calling it a temporary bypass for Riot's hCaptcha. The `RiotClient/… rso-auth (Windows;10;;Professional, x64)` line after that return never runs, and it calls a function that does not exist. If E1 fails with the ShooterGame value, the spike also tries `RiotClient/<riotClientBuild from E5> rso-auth (Windows;10;;Professional, x64)`.

**Headers on every request** (from SkinPeek's `fetch` in `misc/util.js`): `Accept-Language: en-US,en;q=0.5`, and `cookie: dummy=cookie` wherever no real cookie is sent. SkinPeek's comment says both help against Cloudflare error 1020.

**TLS:** SkinPeek forces its own TLS settings in `misc/util.js`: a cipher list (`tlsCiphers`), signature algorithms (`tlsSigAlgs`) and `minVersion: "TLSv1.3"`. Storefront uses a "TLS-tuned HTTPS client". Both references run on Node (OpenSSL); Bun uses BoringSSL, so its TLS fingerprint differs from both Node's default and SkinPeek's tuned one, and their results do not carry over. The first implementation task is a spike: run E1 with Bun's `fetch`. On a 403:

1. If Bun lets `fetch` take those settings, retry with SkinPeek's.
2. Otherwise run the same request under Node 24 with SkinPeek's settings, passed through an undici `Agent({ connect: { ciphers, sigalgs, minVersion } })` as `dispatcher` (Node's `fetch` ignores `https.Agent`). If only Node passes, the service runs on Node.

## Data mapping

The storefront returns UUIDs and prices; names and images come from valorant-api.com. Field names are taken from SkinPeek's `shop.js` and `misc/util.js`.

| Need | Source field | Notes |
| --- | --- | --- |
| The 4 daily skins | `SkinsPanelLayout.SingleItemOffers` (E6) | Array of skin-level UUIDs |
| Time to next reset | `SkinsPanelLayout.SingleItemOffersRemainingDurationInSeconds` (E6) | Drives the scheduler |
| VP price | `SkinsPanelLayout.SingleItemStoreOffers[]` (E6): match `OfferID` to the skin UUID, read `Cost["85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741"]` | That key is VP. If this field ever disappears, fall back to E7 `Offers[]` (same `OfferID` and `Cost`), cached per game version |
| Name, icon, tier | E8: match a skin's `levels[].uuid` to the offer UUID; `displayName`, `displayIcon`, `contentTierUuid` | Cache keyed by E5 `version` |
| Tier colour | E9: `highlightColor` of the tier matching `contentTierUuid` | RGBA hex; drop the alpha and use it as the embed colour |
| Night Market (after MVP) | `BonusStore.BonusStoreOffers[]`: `Offer.Cost[VP]`, `DiscountCosts[VP]`, `DiscountPercent`; `BonusStoreRemainingDurationInSeconds` | `BonusStore` is present only while Night Market is open |
| Accessories (after MVP) | `AccessoryStore.AccessoryStoreOffers[].Offer.Cost["85ca954a-41f2-ce94-9b45-8ca3dd39a00d"]` | That key is Kingdom Credits |

**Internal model:** `ShopSnapshot { fetchedAt, expiresAt, offers: [{ levelUuid, name, iconUrl, vp, tier }], hash }`. `hash` = sha256 of the sorted offer UUIDs + `expiresAt` rounded to the nearest 10 minutes; it deduplicates notifications. `expiresAt` comes from a remaining-seconds count, so it moves by a second or so between fetches; without the rounding, a restart would resend the same shop.

Verified 2026-11-23: the v3 response carries per-offer prices in `SingleItemStoreOffers[].Cost`, so the daily shop needs no E7 call. Its top-level keys were `FeaturedBundle`, `SkinsPanelLayout`, `UpgradeCurrencyStore`, `AccessoryStore` and `PluginStores`; `BonusStore` was absent, as expected while Night Market is closed.

## Storage & secrets

Treat the Riot cookie like a password that also bypasses 2FA ([SkinPeek wiki](https://github.com/giorgi-o/SkinPeek/wiki/How-to-get-your-Riot-cookies)). It lives only on the machine that runs the bot, in two files: the cookie file and the 0600 state file. It is never an environment variable, so it does not show up in `docker inspect` or in Portainer.

**Cookie file** (`config/riot-cookie`, mode 0600, never committed): one line, either the whole `cookie` request header (preferred: Storefront's README says the full set outlives `ssid` alone) or just the `ssid` value. A leading `cookie:`, a BOM and trailing newlines are tolerated. On the server it is `/opt/daily-drip/config/riot-cookie`, owned by uid 1000 (the image's `bun` user); `/opt/daily-drip/config` is bind-mounted read-only at `/app/config`.

Variables come from `.env` on the dev PC (Bun loads it) and from the Portainer stack's Environment variables on the server.

| Variable | Required | How to get it |
| --- | --- | --- |
| `RIOT_COOKIE_FILE` | No | Path of the cookie file; default `config/riot-cookie` |
| `DISCORD_TOKEN` | Yes | [Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token. On the same page, turn off Public Bot |
| `DISCORD_GUILD_ID` | Yes | Discord → User Settings → Advanced → Developer Mode on; right-click your private server → Copy Server ID |
| `DISCORD_CHANNEL_ID` | Yes | Right-click the channel the bot posts in → Copy Channel ID |
| `DISCORD_OWNER_ID` | Yes | Right-click your own name → Copy User ID. Used for pings and to lock `/shop` |
| `RIOT_SHARD` | No | Only if E4 misbehaves; e.g. `ap` |
| `TZ` | No | An IANA time zone name; log timestamps only (Discord shows reset times in each viewer's own time zone) |
| `HEALTHCHECK_URL` | No | Ping URL from an external monitor (e.g. healthchecks.io), called after each successful run |

**Inviting the bot:** Developer Portal → OAuth2 → URL Generator, scopes `bot` and `applications.commands`, permissions View Channel, Send Messages and Embed Links. Open the URL and add the bot to the private server.

**`data/state.json`** (Docker volume, mode 0600, atomic write via temp file + rename) holds:

- the rotated cookie jar, plus a hash of the cookie-file contents it came from;
- `puuid` and `shard`;
- the catalog and price caches, with their game version;
- `lastSentHash` and `lastSuccessAt`;
- the alert flags `cookieDeadNotified`, `blockedNotified` and `deadManNotified`. A successful run clears all three; a new cookie file also clears `cookieDeadNotified`.

**Rules**

- At the start of every run, if the cookie file's hash differs from the stored one, replace the jar. While the cookie is dead, the scheduler checks the file's hash every minute and runs as soon as it changes. Replacing a cookie = overwrite the file; no restart.
- Never log cookies, tokens or `Authorization` headers. The logger drops the values of the `cookie`, `set-cookie`, `authorization`, `x-riot-entitlements-jwt` and E1 `location` headers by name. It also redacts `ssid=`, ` Bearer  `, any `eyJ…` JWT and the value of `DISCORD_TOKEN` (not a JWT, so the `eyJ` rule misses it) anywhere in a line.
- `.env`, `config/`, `data/` and `node_modules/` go in `.gitignore` and `.dockerignore`; ship `.env.example` with empty values.
- No backups of `data/` to any cloud.

## Schedule & notifications

The process is long-running and re-arms itself from the shop's own expiry. There is no cron and no hardcoded reset time, which is the same approach as Storefront.

1. On start: run once immediately.
2. After a successful run: arm a timer for `expiresAt + 90 s`.
3. After a failed run: arm a retry timer with the delay from the Error handling table (default 30 min). Keep retrying at that pace until a run succeeds; only a dead cookie stops retries.
4. If the new snapshot's `hash` equals `lastSentHash`, send nothing; a restart must not resend.
5. Dead-man switch: if `lastSuccessAt` is more than 26 h ago, send one warning (`deadManNotified`). Skip it while `cookieDeadNotified` is set: that alert already went out.
6. After each successful run, call `HEALTHCHECK_URL` if it is set. The external monitor alerts when the pings stop, which covers what the in-process switch cannot: the container or the machine being down.

**Messages (Discord)**, all in `DISCORD_CHANNEL_ID`:

- Daily shop: one message with 4 embeds. Each embed has the skin name as title, the VP price, `displayIcon` as the image and the tier colour (E9) as its colour. The message text is `Resets <t:{expiresAt}:R>`, which Discord shows as a live countdown.
- Wishlist hit: a separate message sent before the shop, naming the skin and mentioning `<@DISCORD_OWNER_ID>` so it pings.
- Cookie dead: one message mentioning the owner, with the steps to grab a new cookie and overwrite the cookie file.
- `lastSentHash` is written only after Discord accepts the message.

**Bot**

- Gateway intent `Guilds` only; no privileged intents.
- Slash commands are registered to `DISCORD_GUILD_ID` on start, so changes show up at once.
- `/shop` is owner-only: if `interaction.user.id` is not `DISCORD_OWNER_ID`, reply with an ephemeral refusal. It replies with the cached snapshot while its `expiresAt` is in the future; otherwise it starts a run and replies with the result (or the cookie-dead notice).
- Every run, scheduled or from `/shop`, takes one lock, so two reauths never overlap. Overlapping reauths would both rotate the cookie and one rotation would be lost.
- No command accepts a cookie: pasting one into Discord would store it on Discord's servers.
- Phone push: in the Discord app, set the channel's notifications to All Messages.

**Wishlist:** `config/wishlist.json` next to the cookie file, re-read on every run, so editing it needs no restart or rebuild. It holds a list of skin names or UUIDs. Names match `displayName` case-insensitively; a substring match is fine ("Reaver" matches every Reaver skin).

Put every channel behind `interface Notifier { sendShop(snapshot, wishlistHits); sendAlert(text) }` so Telegram or ntfy can be added later without touching the core. Slash commands are Discord-only and live outside the interface.

## Error handling

Every failure ends in a bounded retry or a single alert, never a tight loop. Detection rules come from SkinPeek (`detectCloudflareBlock`, `BAD_CLAIMS`, `isMaintenance`); cookie-death causes and the hourly 429 retry come from the Storefront README.

| Symptom | Likely cause | Action |
| --- | --- | --- |
| E1 `Location` is the login page (`authenticate.riotgames.com/login`, or a relative `/login`) | Cookie dead: password change, "sign out of all devices", 2FA change, or Riot flagged the session | Alert once (`cookieDeadNotified`); stop calling auth until the cookie file changes |
| E1 403 with `x-frame-options: SAMEORIGIN`, or no `Set-Cookie`, or no token in the fragment | Cloudflare blocking the IP or the TLS fingerprint | Alert once (`blockedNotified`), retry every 1 h; if it persists from the home IP, switch the TLS client (Endpoints, TLS) |
| 429 on any Riot host | Rate limit | Honour `Retry-After`; default retry after 1 h |
| E6 400 with `errorCode: BAD_CLAIMS` | Token rejected. Tokens are minutes old, so a header or shard problem is likelier than the cookie | Reauth once and retry; if it fails again, alert once and end as a failed run. Never treat it as cookie dead |
| E6 403 with `errorCode: SCHEDULED_DOWNTIME` (SkinPeek's `isMaintenance`) | Riot maintenance | Skip; retry in 30 min |
| E6 fails right after a game patch | Stale `X-Riot-ClientVersion` | Refetch E5, retry once |
| valorant-api.com down | Third-party outage | Send the shop from the cached catalog; uncached items show UUID + price. An embed whose image fails to load still posts, without the image |
| Discord send fails | Discord outage or network | discord.js waits out 429s itself; retry other errors 3 times with backoff. `lastSentHash` stays unchanged, so the shop is resent on the next attempt |

Within one run, the "retry once" rows retry at most 3 times in total. A run that still fails ends as a failed run, and the scheduler's retry timer takes over (Schedule, step 3).

## Project layout & deploy

One small Bun service in one container on `home-server`. It needs only outbound connections (HTTPS, and the Discord gateway over WSS): no open ports, and it works behind CGNAT.

```text
daily-drip/
  scripts/spike.ts     build step 1; runs on Bun and on Node 24
  src/
    config.ts          env parsing + validation (zod)
    http.ts            HTTPS client: TLS options, no auto-redirect, redacting logger
    cookies.ts         Set-Cookie merge, header serialisation
    riot/auth.ts       E1-E4
    riot/store.ts      E6, E7
    catalog.ts         E5, E8, E9 + caches
    state.ts           data/state.json, atomic write, chmod 600
    notify/notifier.ts Notifier interface
    notify/discord.ts  discord.js client, embeds
    commands.ts        /shop, owner check, registration
    scheduler.ts       arm from expiresAt, dead-man switch, run lock
    main.ts
  test/                bun test; fixtures with tokens scrubbed
  config/              local only, gitignored: riot-cookie, wishlist.json
  Dockerfile
  compose.yaml
  .env.example
  .gitattributes       * text=auto eol=lf
```

**Build order**

1. Spike (`scripts/spike.ts`): run E5, E1 → E4, then E6 once under Bun with a real cookie and print the 4 skins. Run it on the dev PC first, then on `home-server`; `--probe` checks Cloudflare alone, without a cookie. This settles the TLS question, and with it Bun vs Node, before anything else is built.
2. Auth + state with cookie rotation.
3. Store + catalog + prices → `ShopSnapshot`.
4. Discord bot: notifier, then `/shop`.
5. Scheduler, dedup, dead-man switch.
6. Error-handling table, then Docker.

**Development on Windows:** the dev PC runs the bot directly with Bun, which runs natively on Windows. It needs neither Docker, WSL, the game nor the Riot Client. Docker runs only on `home-server`, where Portainer builds the image from the GitHub repo; the image is Linux either way.

- Install Bun (`winget install Oven-sh.Bun`), then `bun install` and `bun --watch src/main.ts`. Bun reads the local `.env` by itself, so no dotenv package.
- Use a second Discord application for development, with its own token and channel. Two processes on one bot token would both answer `/shop`.
- Use a separate Riot cookie for development, in the dev PC's own `config/riot-cookie`: sign in again in another browser profile. Each reauth rotates the cookie, so two machines sharing one cookie split its rotation and one copy dies (inferred).
- If the dev PC is on the same home connection as `home-server`, the spike can run there first: same public IP, and Bun bundles its own BoringSSL, so the same Bun version should present the same TLS fingerprint on both. The acceptance check still runs on `home-server`.
- Windows differences the code must tolerate: `chmod` does nothing there (not an error), and renaming over a file another process holds open can fail with `EPERM` (retry a few times).
- Moving to the server: push to GitHub and let Portainer pull from it; don't copy the folder. Only code travels. The server gets its own variables (in Portainer), its own cookie file and the production Discord bot's token, and it starts with an empty `data/`. The dev `state.json` holds the dev cookie jar and must never be copied.

**Deploy:** Dockerfile on `oven/bun:<version>-slim`, pinned to the dev PC's `bun --version`. There is no build stage: `bun install --frozen-lockfile --production`, then `bun src/main.ts` as the image's non-root `bun` user. Create `/app/data` and `chown` it to `bun` before `USER bun`: a new named volume copies that ownership, and without it the volume is root-owned and the bot cannot write state. Commit `bun.lock`.

`compose.yaml` has one service with `restart: unless-stopped`, the named volume `daily-drip-data:/app/data`, the bind mount `/opt/daily-drip/config:/app/config:ro`, and its variables under `environment:` as `${VAR}`, plus `TZ`. Portainer fills `${VAR}` from the stack's Environment variables. There is no `env_file`: `.env` is gitignored, so a stack deployed from Git never sees it. Changing a variable means redeploying the stack (`docker restart` does not re-read variables); replacing the cookie never needs this.

Deploy it as a Portainer stack from the GitHub repo. The repo is private, so Portainer needs credentials: a fine-grained personal access token limited to this repo, with read-only Contents permission, entered as the stack's Git authentication.

## Acceptance criteria

The MVP is done when every box below is ticked on `home-server`, with the real account.

- [ ] Spike: from `home-server`, E1 returns 303 with an `access_token`.
- [ ] One run posts a Discord message with 4 embeds whose names, images and VP prices match the in-game shop (checked by hand once), and it arrives as a push on the phone.
- [ ] `/shop` from the owner shows the current shop without calling Riot; from another account it is refused.
- [ ] Restarting the container the same day sends nothing new.
- [ ] After the next reset, the new shop arrives within 5 minutes without manual action.
- [ ] A run that fails at reset time (network unplugged) is retried, and the shop arrives the same day once the network is back.
- [ ] The rotated cookie is written to state, and the service still works on day 3 without anyone touching it.
- [ ] A broken cookie (one character changed) produces exactly one "cookie dead" message, no retry loop, and no dead-man warning a day later.
- [ ] Overwriting the cookie file with a good cookie recovers within 2 minutes, without a restart.
- [ ] `docker logs` contains no `ssid=`, no ` Bearer  `, no `eyJ` and no Discord bot token.
- [ ] Unit tests cover fragment parsing, `Set-Cookie` merge, offer → snapshot mapping, hash dedup (including a 1-second shift in `expiresAt`), the retry timer and the error table's branches (fixture responses).

## Risks, unknowns & sources

The main risk is that Riot changes these internal endpoints without notice, as it already did when v2 became v3. The official API has no store data at all ([Riot policy](https://support-developer.riotgames.com/hc/en-us/articles/22698769097107)).

**Not verified (test during implementation)**

| Item | Status | How it gets resolved |
| --- | --- | --- |
| Cookie lifetime | No source gives a number | Log the date each cookie dies |
| Bun's TLS from `home-server` | Passed from the dev PC (below) | Spike on `home-server`; fallback in Endpoints, TLS |
| discord.js on Bun | Expected to work; not tested here | Build step 4 |

**Verified by the spike on the dev PC** (2026-11-23, Bun 1.3.14, real cookie)

- E1 returned 303 with the `ShooterGame/13 …` User-Agent: Cloudflare let Bun through. Without a cookie, E1 redirects to `authenticate.riotgames.com/login`.
- E1 rotated `csid`, `ssid`, `ccid` and `clid`.
- E4 returned `ap`.
- E6 v3 carries the prices (Data mapping), so E7 is not needed.
- The daily shop resets at 00:00 UTC.

**Risks**

- Account action: Riot has made no official statement about store checkers. The requests are read-only and identical to the client's, so the risk is judged low (inferred).
- A leaked cookie = a compromised account, with 2FA bypassed. That is why it stays on the box only.
- The references age: SkinPeek has been archived since 2025-06-04, and its User-Agent is a 2023 workaround (Endpoints, User-Agent).

**Sources**

- [giorgi-o/SkinPeek](https://github.com/giorgi-o/SkinPeek): source read at commit `67882a0` (the final commit; `auth.js`, `shop.js` and `util.js` re-read 2026-11-23): `valorant/auth.js`, `valorant/shop.js`, `valorant/cache.js`, `misc/util.js`
- [SkinPeek issues](https://github.com/giorgi-o/SkinPeek/issues): archive notice
- [SkinPeek wiki: How to get your Riot cookies](https://github.com/giorgi-o/SkinPeek/wiki/How-to-get-your-Riot-cookies)
- [exoflex6/Storefront](https://github.com/exoflex6/Storefront): README (flow, cookie rotation, reset timing, Cloudflare notes)
- [valapidocs: Storefront](https://valapidocs.techchrism.me/endpoint/storefront) (documents v2)
- [valorant-api-docs: Common components](https://techchrism.github.io/valorant-api-docs/common-components.html) (token lifetime)
- [Riot Developer API Policy: VALORANT](https://support-developer.riotgames.com/hc/en-us/articles/22698769097107)
