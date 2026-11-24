# Valorant Store Checker — Spec

Nov 23, 2026

## Goal & scope

After every shop reset, a Discord bot on `home-server` fetches the owner's 4 daily Valorant skins and posts them to a private Discord channel with name, image and VP price; the Discord app pushes them to his phone. It is read-only and needs neither the game nor the Riot Client running, on the server or on the development PC.

**MVP**

- Fetch the daily shop (4 skins) after each reset and send one message.
- Wishlist: when a wishlisted skin appears, send an extra message that pings the owner.
- When the cookie dies, notify exactly once with instructions to replace it.
- `/shop` slash command: shows the current shop on demand, from the cached snapshot.
- `/wishlist add | remove | list | clear`: manage the wishlist from Discord. `add` picks a gun, then one of its current skins, both with autocomplete.

**After MVP**

- Night Market, Accessory store, featured bundle.
- Other members of the private server, each with their own Riot account (Accounts, in progress).

**Non-goals**

- Public use: the bot serves a few people in one private server, never anyone who asks.
- Username/password login: that flow is behind hCaptcha.
- Purchases or any write request to Riot.
- Touching the game client.

## Decisions

Cookie reauth, run in Docker on `home-server`, written in TypeScript, notifications via a Discord bot. The last column says which choices can change without touching the rest.

| Area | Default | Why | Changeable? |
| --- | --- | --- | --- |
| Auth | Cookie reauth (full cookie header, or `ssid` alone) | No password, no captcha | No: every other route is worse |
| Host | `home-server`, Docker container (Compose project in `~/daily-drip`) | Residential IP; Riot's Cloudflare often blocks VPS/cloud IPs | Another home machine yes; avoid VPS |
| Runtime | TypeScript on Bun, same version on the dev PC and in the Dockerfile | Runs TypeScript directly (no build step), built-in test runner and `.env` loading | Yes: Node 24 if the TLS spike fails under Bun. Bun-only APIs stay in `http.ts`, so switching touches one file |
| Notifications | Discord bot (discord.js) posting in a private server | Phone push via the Discord app; 4 embeds with image, name and price in one message; slash commands; the gateway connection is outbound-only, so no open ports | Yes: behind a `Notifier` interface (Telegram, ntfy) |
| Schedule | Arm from `...RemainingDurationInSeconds` + 90 s | No hardcoded reset time | No |
| Repo | GitHub `tyler-void/daily-drip`, MIT. Public | The repo holds no secret: the cookie and state live in `config/` and `data/`, which are gitignored. Public lets friends run their own copy instead of handing over their cookies | Yes |

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
5. Get the PUUID from the `sub` field of userinfo (E3); cache it in state. E3 runs on every run anyway: its `acct.game_name` and `acct.tag_line` give the Riot ID shown on shop posts, which can change.
6. Get the region from `affinities.live` (E4) and map it to a shard: `latam` and `br` use `na`; any other value is the shard itself (SkinPeek's `userRegion`). Cache it in state. `RIOT_SHARD` overrides it. Code must not assume a particular shard.
7. Tokens live about 1 hour ([valapidocs](https://techchrism.github.io/valorant-api-docs/common-components.html)). Reauth from scratch on every run; never keep tokens between runs.

**Getting the cookie the first time (manual):** sign in at auth.riotgames.com in a Chromium-based browser. Open DevTools → Network, pick any request to auth.riotgames.com, right-click the `cookie` request header → Copy value, and paste it into the cookie file. The [SkinPeek wiki](https://github.com/giorgi-o/SkinPeek/wiki/How-to-get-your-Riot-cookies) says Firefox truncates long cookies, so do not use LibreWolf for this step.

## Endpoints & headers

The storefront is now **v3, POST with body `{}`**. valapidocs still documents v2 GET, but both SkinPeek and Storefront call v3. Every row comes from SkinPeek's source (`valorant/auth.js`, `shop.js`, `cache.js`) unless noted.

| # | Method | URL | Headers / body | Returns |
| --- | --- | --- | --- | --- |
| E1 | GET | `https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&scope=account%20openid&nonce=1` | `Cookie`, `User-Agent` (below); do not follow redirects | 303; `access_token` + `id_token` in the `Location` fragment; rotated cookies in `Set-Cookie` |
| E2 | POST | `https://entitlements.auth.riotgames.com/api/token/v1` | `Authorization: Bearer <access_token>`, `Content-Type: application/json` | `entitlements_token` |
| E3 | GET | `https://auth.riotgames.com/userinfo` | Bearer | `sub` = PUUID; `acct.game_name`, `acct.tag_line` = Riot ID |
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

**Internal model:** `ShopSnapshot { fetchedAt, expiresAt, offers: [{ levelUuid, name, iconUrl, vp, tier: { name, color } | null }], hash }`. `hash` = sha256 of the sorted offer UUIDs + `expiresAt` rounded to the nearest 10 minutes; it deduplicates notifications. `expiresAt` comes from a remaining-seconds count, so it moves by a second or so between fetches; without the rounding, a restart would resend the same shop.

Verified 2026-11-23: the v3 response carries per-offer prices in `SingleItemStoreOffers[].Cost`, so the daily shop needs no E7 call. Its top-level keys were `FeaturedBundle`, `SkinsPanelLayout`, `UpgradeCurrencyStore`, `AccessoryStore` and `PluginStores`; `BonusStore` was absent, as expected while Night Market is closed.

## Storage & secrets

Treat the Riot cookie like a password that also bypasses 2FA ([SkinPeek wiki](https://github.com/giorgi-o/SkinPeek/wiki/How-to-get-your-Riot-cookies)). It lives only on the machine that runs the bot, in two files: the cookie file and the 0600 state file. It is never an environment variable, so it does not show up in `docker inspect`.

**Cookie file** (`config/riot-cookie`, mode 0600, never committed): one line, either the whole `cookie` request header (preferred: Storefront's README says the full set outlives `ssid` alone) or just the `ssid` value. A leading `cookie:`, a BOM and trailing newlines are tolerated. On the server it is `~/daily-drip/config/riot-cookie`, owned by uid 1000 (the image's `bun` user); that `config/` folder (mode 0700) is bind-mounted read-only at `/app/config`.

Variables come from `.env` on the dev PC (Bun loads it). On the server they come from `~/daily-drip/.env` (mode 0600), which Compose reads to fill `${VAR}` in `compose.yaml`; the file itself never enters the image or the container.

| Variable | Required | How to get it |
| --- | --- | --- |
| `RIOT_COOKIE_FILE` | No | Path of the cookie file; default `config/riot-cookie` |
| `DISCORD_TOKEN` | Yes | [Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token. On the same page, turn off Public Bot |
| `DISCORD_GUILD_ID` | Yes | Discord → User Settings → Advanced → Developer Mode on; right-click your private server → Copy Server ID |
| `DISCORD_CHANNEL_ID` | Yes | Right-click the channel the bot posts in → Copy Channel ID |
| `DISCORD_OWNER_ID` | Yes | Right-click your own name → Copy User ID. Used for pings and to lock `/shop` |
| `RIOT_SHARD` | No | Only if E4 misbehaves; e.g. `ap` |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn` or `error`. `debug` logs each request's host, path, status and time, never its headers |
| `TZ` | No | An IANA time zone name; log timestamps only (Discord shows reset times in each viewer's own time zone) |
| `HEALTHCHECK_URL` | No | Ping URL from an external monitor (e.g. healthchecks.io), called after each successful run |

**Inviting the bot:** Developer Portal → OAuth2 → URL Generator, scopes `bot` and `applications.commands`, permissions View Channel, Send Messages and Embed Links. Open the URL and add the bot to the private server. At startup the bot checks that it is in `DISCORD_GUILD_ID` and can post in `DISCORD_CHANNEL_ID`; if not, it logs what is wrong, with the invite link (scopes and permission value `19456` filled in), and exits.

**`data/state.json`** (Docker volume, mode 0600, atomic write via temp file + rename) holds:

- the rotated cookie jar, plus a hash of the cookie-file contents it came from;
- `puuid` and `shard`;
- `snapshot`: the latest `ShopSnapshot`, which `/shop` answers from;
- `wishlist`: the entries managed with `/wishlist`;
- `lastSentHash` and `lastSuccessAt`;
- the alert flags `cookieDeadNotified`, `blockedNotified`, `badClaimsNotified` and `deadManNotified`. A successful run clears all four; a new cookie file also clears `cookieDeadNotified`.

**`data/catalog.json`** (mode 0644; nothing secret; versioned by a `schema` number, and fetched again when the number changes): the skin catalog from E8 and E9, with each skin's weapon, plus E7 prices if they are ever needed, for one game version. It is about 0.6 MB and changes only after a game patch, so it is kept out of `state.json`, which is rewritten on every cookie rotation.

**Rules**

- At the start of every run, if the cookie file's hash differs from the stored one, replace the jar. While the cookie is dead, the scheduler checks the file's hash every minute and runs as soon as it changes. Replacing a cookie = overwrite the file; no restart.
- Never log cookies, tokens or `Authorization` headers. The logger drops the values of the `cookie`, `set-cookie`, `authorization`, `x-riot-entitlements-jwt` and E1 `location` headers by name. It also redacts `ssid=`, ` Bearer  `, any `eyJ…` JWT and the value of `DISCORD_TOKEN` (not a JWT, so the `eyJ` rule misses it) anywhere in a line.
- `.env`, `config/`, `data/` and `node_modules/` go in `.gitignore` and `.dockerignore`; ship `.env.example` with empty values.
- No backups of `data/` to any cloud.

## Schedule & notifications

The process is long-running and re-arms itself from the shop's own expiry. There is no cron and no hardcoded reset time, which is the same approach as Storefront. Instead of one long timer, a tick every minute compares the wall clock with the next run time: long timers stop counting while a machine sleeps and fire late, while a tick catches up within a minute of waking.

1. On start: run once immediately.
2. After a successful run: arm a timer for `expiresAt + 90 s`, and at least a minute ahead, so an already-expired answer cannot cause a tight loop.
3. After a failed run: arm a retry timer with the delay from the Error handling table (default 30 min). Keep retrying at that pace until a run succeeds; only a dead cookie stops retries.
4. If the new snapshot's `hash` equals `lastSentHash`, send nothing; a restart must not resend.
5. Dead-man switch: if `lastSuccessAt` is more than 26 h ago, send one warning (`deadManNotified`). Skip it while `cookieDeadNotified` is set: that alert already went out.
6. After each successful run, call `HEALTHCHECK_URL` if it is set. The external monitor alerts when the pings stop, which covers what the in-process switch cannot: the container or the machine being down. On healthchecks.io, set the check's period to 1 day and its grace time to 2 hours.
7. An alert's flag is set only once the alert has been sent; one that fails to send goes out on the next failure. Alert texts pass through the redacting logger's `redact()` first.

**Messages (Discord).** Everyone's shop is public; wishlists are private.

- Daily shop, in `DISCORD_CHANNEL_ID`: one message with 4 embeds per person, the owner and each linked member. Each embed has the skin name as title, the VP price, `displayIcon` as the image and the tier colour (E9) as its colour. The text is `<@person>'s daily shop (Name#Tag) · resets <t:{expiresAt}:R>`: it names whose shop it is by Discord mention and Riot ID (escaped, so a Riot ID can't change the formatting; left out while unknown) and pings them, and Discord shows the reset as a live countdown.
- Links on each skin (`src/links.ts`). The skin name (embed title) links to its collection's Fandom wiki page, and a line under the price reads `Fandom · Trailer · Preview`. The image can't carry a link: clicking it always opens the image.
  - Fandom: the page `<collection> Collection`. The collection is the skin's theme on valorant-api.com (`/v1/themes`). Which pages exist is checked once per game version with Fandom's MediaWiki API (50 titles per request, following redirects) and cached in `catalog.json`. A missing page, or a failed check, links to Fandom's search instead. On 2026-11-24, 1,148 of 1,396 store skins had a direct page.
  - Trailer: a YouTube search for `VALORANT <collection> skins trailer`, so the query is visible and no API key is needed.
  - Preview: Riot's own in-game preview video of the fully upgraded skin (`streamedVideo` of its last level that has one; level 1's shows only the base model), when the skin has one; 585 of 1,396 store skins do. op.gg shows the same Riot videos and nothing for the rest, so it isn't used.
- Preview videos: a second channel message right after each shop post (and as a follow-up to a `/shop` reply), with each skin's name and its preview video URL on its own line. A bot can't put a video inside an embed, and most videos are far over the 10 MB upload limit (median about 28 MB), but Discord plays a bare video link inline (checked 2026-11-24). Best-effort: if it fails, the shop is not posted again.
  - Riot's site has no page per collection, so there is no Riot link.
- Wishlist hit: a DM to that person, sent before their shop, naming the skin. A wishlist is private, so hits never go in the channel. If someone blocks DMs from server members, one note in the channel (once per process) asks them to allow them; it names no skin, and the shop is still posted.
- Cookie dead: one message mentioning the owner, with the steps to grab a new cookie and overwrite the cookie file.
- `lastSentHash` is written only after Discord accepts the message.

**Bot**

- Gateway intent `Guilds` only; no privileged intents.
- Slash commands are registered to `DISCORD_GUILD_ID` on start, so changes show up at once.
- `/shop` answers the owner and linked members, each about their own account, in public and named like the daily post but without a ping. Anyone else gets an ephemeral refusal (or, with linking on, a pointer to `/link`). It replies with the cached snapshot while its `expiresAt` is in the future; otherwise it starts a run and replies with the result (or the cookie-dead or link-again notice). `/wishlist` replies are always ephemeral.
- Every run, scheduled or from `/shop`, takes one lock, so two reauths never overlap. Overlapping reauths would both rotate the cookie and one rotation would be lost.
- No command accepts a cookie: pasting one into Discord would store it on Discord's servers.
- Phone push: each shop post mentions its person, so the channel's default "Only @mentions" notifications are enough.

**Wishlist:** managed with `/wishlist` and kept in `state.json`, because `config/` is mounted read-only on the server. If a `config/wishlist.json` (a JSON array of strings) exists on the first start, it is imported once. Entries are skin names, parts of one, or UUIDs; names match `displayName` case-insensitively as substrings ("Reaver" matches every Reaver skin). At most 25 entries, each 2 to 64 characters, so `/wishlist list` stays under Discord's 2000-character limit.

- `/wishlist add weapon skin`: `weapon` autocompletes "Any weapon" plus every gun in the catalog (E8 `displayName`; knives are "Melee"). `skin` then autocompletes that gun's current store skins (those with a content tier). A gun with a part of a name that only one of its skins has is stored as that skin's full name; an ambiguous part is refused with a hint. With "Any weapon", the typed text is offered first and stored as it is, so a partial name matches every gun.
- `/wishlist remove entry` autocompletes the current entries; `list` marks entries that are in today's shop; `clear` empties it.
- Replies are ephemeral. Saving takes the run lock, so the reply is deferred first.

Put every channel behind `interface Notifier { sendShop(snapshot, wishlistHits); sendAlert(text) }` so Telegram or ntfy can be added later without touching the core. Slash commands are Discord-only and live outside the interface.

## Accounts (multi-user, in progress)

Besides the owner, up to 10 members of the private server can link their own Riot account. The owner keeps using the cookie file. Members never send a cookie or a password.

**Registry** (`src/accounts.ts`, stored in `state.json` under `accounts`): one entry per Discord user, keyed by the user id. It is the link between the two sides:

| Side | Stable key | Kept for display |
| --- | --- | --- |
| Discord | User id | Username, from the link or the last one seen |
| Riot | PUUID, once a login has succeeded | Riot ID (`gameName#tagLine`) |

- One Riot account per Discord user, and one Discord user per Riot account. Two entries for one account would split its cookie rotation, and one copy would die.
- The owner is added on every start, with the owner role, and can't be removed with a command.
- At most 10 members. Riot rate-limits an IP when many accounts sign in close together ([SkinPeek admin guide](https://github.com/giorgi-o/SkinPeek/wiki/SkinPeek-Admin-Guide)), and every member is someone whose account access the server holds.

**Onboarding: a Riot sign-in link.** `/link` gives the member a link to Riot's own sign-in page: the Riot Client's OAuth authorization-code flow, client `riot-client`, redirect `http://localhost/redirect`, scope `openid link ban lol_region account offline_access`.
1. They sign in there, with 2FA if they use it. Their browser then lands on a dead `http://localhost/redirect?code=…` address, which they copy into a modal.
2. The bot trades the one-time code (form-encoded `POST https://auth.riotgames.com/token`, `grant_type=authorization_code`) for an access token (1 hour), an ID token and a refresh token, and keeps only the refresh token.
3. Each run trades the refresh token (`grant_type=refresh_token`) for fresh tokens, then runs E2 to E6 as for the owner.

No cookie and no password is typed anywhere. The pasted code is single-use and expires within minutes. Discord's developer policy still asks bots not to collect login credentials; a short-lived, single-use code keeps that exposure small but does not remove it.

Checked on 2026-11-24 on the owner's account with `scripts/code-spike.ts`: code exchange, one refresh, E2, E3, E4 and E6 (4 offers), same account as the cookie. The refresh token did not change on that refresh. Other projects report that Riot rotates it on every use and that two overlapping refreshes break the link, so the bot saves whatever token comes back before doing anything else, and the run lock keeps refreshes from overlapping. `invalid_grant` means the link is dead. How long a refresh token lives is not documented.

Ruled out:
- **Riot Mobile QR login.** Riot Mobile signed in an account run by a regional partner publisher, then failed fetching the partner's token and showed "We can't connect to the servers". A member with such an account can't approve a QR code.
- **Pasting a cookie into Discord.** Discord can read message and modal contents, a modal input holds at most 4,000 characters, and the cookie is a long-lived key that gets around 2FA.
- **A web form behind the Cloudflare tunnel.** TLS ends at Cloudflare, so Cloudflare could read what is sent.

**Built** (on with `TOKEN_KEY`; without it the bot serves only the owner):

- `/link` answers privately with the steps, a "Sign in with Riot" button and a "Paste the address" button that opens a form. `/unlink` deletes the member's entry: sign-in token, shop and wishlist. It can't end the Riot sign-in itself, so the reply points to "Sign out of all devices" in the Riot account settings.
- `/shop` and `/wishlist` answer a linked member about their own account: `/shop` in public, `/wishlist` privately. Anyone else who isn't the owner is told to `/link`. `/link` tells members before they sign in that their shop will be public and their wishlist private.
- Each member's shop runs 90 s after their reset, members one after another, 5 s apart, under the shared run lock (`src/memberScheduler.ts`). A rate limit or a Cloudflare block stops the round for everyone.
- Members' shops are posted in the channel and ping them, like the owner's; their wishlist hits and the link-again alert go by DM (Messages, above).
- A dead sign-in (`invalid_grant`) DMs the member once to link again, then pauses their runs until they do.
- Refresh tokens are sealed with AES-256-GCM (`src/secretbox.ts`). The key, `TOKEN_KEY` (32 random bytes, base64), lives in `.env`, outside the data volume: a leaked `state.json` or backup alone can't be used. It doesn't protect against the key's holder or root on the server, since the bot decrypts the token to use it unattended. Losing the key means every member links again.

**Checked on 2026-11-24 on the server:** a real member linked through `/link`, the paste form and Riot's sign-in page; their refresh token was stored sealed, and the member scheduler posted their shop in the channel 10 s later.

**Not checked yet:** a member's post after a reset, a wishlist hit by DM, and how long a refresh token keeps working.

## Error handling

Every failure ends in a bounded retry or a single alert, never a tight loop. Detection rules come from SkinPeek (`detectCloudflareBlock`, `BAD_CLAIMS`, `isMaintenance`); cookie-death causes and the hourly 429 retry come from the Storefront README.

| Symptom | Likely cause | Action |
| --- | --- | --- |
| E1 `Location` is the login page (`authenticate.riotgames.com/login`, or a relative `/login`) | Cookie dead: password change, "sign out of all devices", 2FA change, or Riot flagged the session | Alert once (`cookieDeadNotified`); stop calling auth until the cookie file changes |
| E1 403 with `x-frame-options: SAMEORIGIN`, or no `Set-Cookie`, or no token in the fragment | Cloudflare blocking the IP or the TLS fingerprint | Alert once (`blockedNotified`), retry every 1 h; if it persists from the home IP, switch the TLS client (Endpoints, TLS) |
| 429 on any Riot host | Rate limit | Honour `Retry-After`; default retry after 1 h |
| E6 400 with `errorCode: BAD_CLAIMS` | Token rejected. Tokens are minutes old, so a header or shard problem is likelier than the cookie | Reauth once and retry; if it fails again, alert once (`badClaimsNotified`) and end as a failed run. Never treat it as cookie dead |
| E6 403 with `errorCode: SCHEDULED_DOWNTIME` (SkinPeek's `isMaintenance`) | Riot maintenance | Skip; retry in 30 min |
| E6 fails right after a game patch | Stale `X-Riot-ClientVersion` | Refetch E5, retry once |
| valorant-api.com down | Third-party outage | Send the shop from the cached catalog; uncached items show UUID + price. An embed whose image fails to load still posts, without the image |
| Discord send fails | Discord outage or network | discord.js waits out 429s itself; retry other errors 3 times, after 5, 15 and 45 s. Then the run fails; `lastSentHash` stays unchanged, so the next attempt resends the shop |

Within one run, the "retry once" rows retry at most 3 times in total. A run that still fails ends as a failed run, and the scheduler's retry timer takes over (Schedule, step 3).

## Project layout & deploy

One small Bun service in one container on `home-server`. It needs only outbound connections (HTTPS, and the Discord gateway over WSS): no open ports, and it works behind CGNAT.

```text
daily-drip/
  scripts/spike.ts     build step 1; runs on Bun and on Node 24
  src/
    config.ts          env parsing + validation (zod)
    http.ts            HTTPS client: base headers, no auto-redirect, timeouts
    log.ts             redacting logger
    cookies.ts         Set-Cookie merge, header serialisation
    riot/auth.ts       E1-E4
    riot/store.ts      E6, E7
    catalog.ts         E5, E8, E9; cache in data/catalog.json
    shop.ts            one run: auth → E6 → catalog → ShopSnapshot; the retry-once rules
    post.ts            one scheduled run: fetch, dedup, wishlist, send with retries
    alerts.ts          alert texts
    files.ts           atomic writes (temp file + rename)
    state.ts           data/state.json, chmod 600
    notify/notifier.ts Notifier interface
    notify/discord.ts  discord.js client, startup check, message layouts
    commands.ts        /shop, owner check, registration
    lock.ts            run lock: scheduled runs and /shop never overlap
    wishlist.ts        entries, matching, one-time import of config/wishlist.json
    scheduler.ts       one-minute tick: next run, retry timer, alerts, dead-man switch, cookie-file polling
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
2. Auth + state with cookie rotation. The first run imports the spike's rotated cookies (`data/spike-jar.json`, renamed to `.imported`). From then on the bot owns the cookie, and the spike refuses a real-cookie run (`--probe` still works).
3. Store + catalog + prices → `ShopSnapshot`.
4. Discord bot: notifier, then `/shop`, the wishlist, and dedup (`lastSentHash`), so restarts during development post nothing new.
5. Scheduler: next-reset timer, retry timer, dead-man switch, cookie-file polling, and the error table's delays and one-time alerts (the scheduler cannot pick a retry time without them).
6. Docker and deploy: `Dockerfile`, `compose.yaml`, `scripts/deploy.sh`; notes in `docs/step-6-deploy.md`.

**Development on Windows:** the dev PC runs the bot directly with Bun, which runs natively on Windows. It needs neither Docker, WSL, the game nor the Riot Client. Docker runs only on `home-server`, which builds the image itself from the synced files; the image is Linux either way.

- Install Bun (`winget install Oven-sh.Bun`), then `bun install` and `bun --watch src/main.ts`. Bun reads the local `.env` by itself, so no dotenv package.
- Use a second Discord application for development, with its own token and channel. Two processes on one bot token would both answer `/shop`.
- Use a separate Riot cookie for development, in the dev PC's own `config/riot-cookie`: sign in again in another browser profile. Each reauth rotates the cookie, so two machines sharing one cookie split its rotation and one copy dies (inferred).
- If the dev PC is on the same home connection as `home-server`, the spike can run there first: same public IP, and Bun bundles its own BoringSSL, so the same Bun version should present the same TLS fingerprint on both. The acceptance check still runs on `home-server`.
- Windows differences the code must tolerate: `chmod` does nothing there (not an error), and renaming over a file another process holds open can fail with `EPERM` (retry a few times).
- Moving to the server: `scripts/deploy.sh` syncs only what the image needs; don't copy the folder. Only code travels. The server gets its own `.env`, its own cookie file and the production Discord bot's token, and it starts with an empty `data/`. The dev `state.json` holds the dev cookie jar and must never be copied.

**Deploy:** Dockerfile on `oven/bun:<version>-slim`, pinned to the dev PC's `bun --version`. There is no build stage: `bun install --frozen-lockfile --production`, then `bun src/main.ts` as the image's non-root `bun` user. Create `/app/data` and `chown` it to `bun` before `USER bun`: a new named volume copies that ownership, and without it the volume is root-owned and the bot cannot write state. Commit `bun.lock`.

`compose.yaml` has one service with `restart: unless-stopped`, the named volume `daily-drip-data:/app/data`, the bind mount `./config:/app/config:ro`, and its variables under `environment:` as `${VAR}`; `TZ` defaults to UTC. Compose fills `${VAR}` from the `.env` next to `compose.yaml`. There is no `env_file`, so the container gets only the variables it uses. The container is locked down: read-only root filesystem, all capabilities dropped, `no-new-privileges`, 256 MB and 128 processes at most, logs capped at 10 MB × 3, no ports. Changing a variable means `docker compose up -d` again (`docker restart` does not re-read variables); replacing the cookie never needs this.

Deploy from the dev machine with `DEPLOY_HOST=<server> scripts/deploy.sh`: it copies `src/` and the build files to `~/daily-drip` with `rsync -rlt`, builds the image on the server and runs `docker compose up -d`. It never touches the server's `.env`, `config/` or the data volume, and it starts nothing until `.env` and `config/riot-cookie` exist. The server needs no GitHub access.

## Acceptance criteria

The MVP is done when every box below is ticked on `home-server`, with the real account.

- [x] Spike: from `home-server`, E1 returns 303 with an `access_token`.
- [x] One run posts a Discord message with 4 embeds whose names, images and VP prices match the in-game shop (checked by hand once), and it arrives as a push on the phone.
- [x] `/shop` from the owner shows the current shop without calling Riot; from another account it is refused.
- [ ] `/wishlist add` with a gun suggests only that gun's skins; the entry survives a restart and pings when the skin is in the shop.
- [x] Restarting the container the same day sends nothing new.
- [ ] After the next reset, the new shop arrives within 5 minutes without manual action.
- [ ] A run that fails at reset time (network unplugged) is retried, and the shop arrives the same day once the network is back.
- [ ] The rotated cookie is written to state, and the service still works on day 3 without anyone touching it.
- [ ] A broken cookie (one character changed) produces exactly one "cookie dead" message, no retry loop, and no dead-man warning a day later.
- [ ] Overwriting the cookie file with a good cookie recovers within 2 minutes, without a restart.
- [x] `docker logs` contains no `ssid=`, no ` Bearer  `, no `eyJ` and no Discord bot token.
- [x] Unit tests cover fragment parsing, `Set-Cookie` merge, offer → snapshot mapping, hash dedup (including a 1-second shift in `expiresAt`), the retry timer and the error table's branches (fixture responses).

## Risks, unknowns & sources

The main risk is that Riot changes these internal endpoints without notice, as it already did when v2 became v3. The official API has no store data at all ([Riot policy](https://support-developer.riotgames.com/hc/en-us/articles/22698769097107)).

**Not verified (test during implementation)**

| Item | Status | How it gets resolved |
| --- | --- | --- |
| Cookie lifetime | No source gives a number | Log the date each cookie dies |
| Bun's TLS from `home-server` | Passed from the dev PC (below). From `home-server`, in the container image, the cookie-less probe passed on 2026-11-23 (303 to the login page) | First real run on `home-server`; fallback in Endpoints, TLS |
| discord.js on Bun | Works on the dev PC (discord.js 14.28.1, Bun 1.3.14): login, guild command registration, embeds, `/shop` | Check again in the container on `home-server` |

**Verified by the spike on the dev PC** (2026-11-23, Bun 1.3.14, real cookie)

- E1 returned 303 with the `ShooterGame/13 …` User-Agent: Cloudflare let Bun through. Without a cookie, E1 redirects to `authenticate.riotgames.com/login`.
- E1 rotated `csid`, `ssid`, `ccid` and `clid`.
- E4 returned `ap`.
- E6 v3 carries the prices (Data mapping), so E7 is not needed.
- The daily shop resets at 00:00 UTC.
- Two fetches a second apart computed `expiresAt` as 00:00:00.340 and 23:59:59.505 UTC. Without the 10-minute rounding, the dedup hash would have changed between them.

**Risks**

- Account action: Riot's VALORANT developer policy lists "online store tracking" as an unapproved use case ([Riot](https://support-developer.riotgames.com/hc/en-us/articles/22698769097107-VALORANT)), and its Terms of Service forbid letting anyone else access an account. No ban caused by a store checker has been confirmed. The requests are read-only and identical to the client's, so the risk for the owner's own account is judged low (inferred).
- Serving members raises that risk: the server then holds other people's account access, and the bot becomes a service for others rather than a personal tool. Keep it to a few people in one private server (Accounts).
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
