# daily-drip — Match Recap Spec

Nov 25, 2026

## Goal & scope

After every match played by someone on the recap roster, daily-drip posts one recap: result, map, queue, and each tracked player's agent, K/D/A, ACS, HS%, ADR and RR change, plus the full 10-player scoreboard. It adds no Riot traffic while nobody on the roster is playing.

The roster has two tiers, decided by what the bot already holds:

| Tier | Who | Data source | RR change |
| --- | --- | --- | --- |
| Linked | The owner, and members who `/link`ed for the shop | Riot `pd` endpoints with that person's own session | Exact, from competitive updates |
| Followed | Friends who are not linked and add their own Riot ID with `/recap join` | HenrikDev API | From HenrikDev MMR history |

**MVP**

- Recaps for competitive, unrated and swiftplay; one message per match, even when several tracked players were in it.
- Presence-gated polling (Triggers), with a slow sweep as a safety net.
- `/recap on`, `off`, `join`, `leave`, `list`, and the owner-only `/recap remove`.

**After MVP**

- KAST, first bloods, clutches; weekly summary with an RR chart.

**Non-goals**

- tracker.gg as a source (Data sources explains why).
- Tracking anyone who has not opted in themselves.
- Deathmatch, team deathmatch and custom games.

## Data sources

Use each person's own Riot session when the bot has one, HenrikDev otherwise, and never tracker.gg. One match-details call returns every player's stats, so a team recap costs no more than a solo one.

| Source | Used for | What it returns | Cost | Status |
| --- | --- | --- | --- | --- |
| Riot `pd`, person's own session | Linked tier | History, details for all 10 players, competitive updates with exact RR | \~3 calls per match + a session per hour | Endpoints documented on [valapidocs](https://valapidocs.techchrism.me/endpoint/match-history); same risk profile as the shop |
| Riot `pd`, owner's session, someone else's PUUID | Optional shortcut for the followed tier | Same as above | Same | Unverified: valapidocs neither allows nor forbids it. Spike S2 decides; if it is refused, drop it |
| [HenrikDev](https://docs.henrikdev.xyz) v4 | Followed tier | Matches with per-player stats incl. head/body/leg shots; MMR history with `last_change` | Rate limit per key; background Riot fetches count too | Free key from the HenrikDev dashboard |
| tracker.gg internal API (`api.tracker.gg/api/v2/valorant/...`) | Nothing | Profile and match pages | n/a | **Rejected.** Tracker Network staff: "We don't allow anyone to use our internal API" ([forum](https://feedback.tracker.gg/t/valorant-api-inquiry/28078)). Their public API has no Valorant |

**Source chain per roster entry:** linked → own session; followed → owner's session if S2 passes, else HenrikDev. The chain is fixed when the entry is created and re-evaluated only when someone links or unlinks.

The tracker.gg request that works in a browser rides on that browser's tracker.gg session and Cloudflare clearance. A bot replaying it would break that rule and would need to keep beating Cloudflare, for data the bot can already get first-hand.

## Triggers

Presence decides **when to poll**, not when a match ended. The game client stays open between matches, so "Playing VALORANT" usually spans a whole session of several matches (inferred; spike S1 confirms).

1. **Playing:** while a roster member's Discord presence shows a Playing activity named `VALORANT` (case-insensitive), poll their newest match every 4 min.
2. **Stopped:** when that activity disappears, poll at +2, +5 and +10 min, then stop. Match history can lag a few minutes behind the end of a match.
3. **No presence:** a member who doesn't share activity status, or plays off PC, falls back to a poll every 20 min. Set per roster entry (`trigger: "presence" | "poll"`), defaulting to `presence`.
4. **Sweep:** once a day at 04:00 local, check every roster entry's last 5 matches. Recap anything from the past 24 h that was missed, marked "late".

A poll is one cheap history call. Details, RR and the post happen only when a new match ID shows up.

**Discord setup:** turn on the Presence Intent in the Developer Portal (Bot → Privileged Gateway Intents) **and** add `GatewayIntentBits.GuildPresences` in `startDiscord`. Apps with fewer than 10,000 users can toggle it without review ([Discord](https://support-dev.discord.com/hc/articles/4404772028055)). Listen on `Events.PresenceUpdate`; `oldPresence` can be null, so compare against the bot's own record of who was playing, not against `oldPresence`.

## Riot pd endpoints & stat formulas

Three new endpoints, all with the existing 4 game headers (`gameHeaders` in `src/riot/store.ts`). Numbering continues the main spec's table.

| # | Method | URL | Use |
| --- | --- | --- | --- |
| E10 | GET | `https://pd.{shard}.a.pvp.net/match-history/v1/history/{puuid}?startIndex=0&endIndex=5` | Newest match IDs: `History[].MatchID`, `GameStartTime`, `QueueID` |
| E11 | GET | `https://pd.{shard}.a.pvp.net/match-details/v1/matches/{matchId}` | Everything in the recap |
| E12 | GET | `https://pd.{shard}.a.pvp.net/mmr/v1/players/{puuid}/competitiveupdates?startIndex=0&endIndex=5&queue=competitive` | RR: `RankedRatingEarned`, `RankedRatingAfterUpdate`, `TierAfterUpdate`, matched on `MatchID` |

Sources: valapidocs pages for [E10](https://valapidocs.techchrism.me/endpoint/match-history), [E11](https://valapidocs.techchrism.me/endpoint/match-details) and [E12](https://valapidocs.techchrism.me/endpoint/competitive-updates).

**Session reuse (new rule).** The shop reauths from scratch on every run; recap polls must not. E1 rotates the owner's cookie on every call, so polling every 4 min would rotate it 15 times an hour. Keep each person's `Session` **in memory only** for 50 min (tokens live about an hour), and drop it early on a 401 or `BAD_CLAIMS`. Members' refresh-token sessions are cached the same way. Nothing new is written to `state.json`. Getting a session still goes through the run lock, so a shop run and a recap never refresh the same credentials at once.

**Formulas** (E11; `p` = the player in `players[]`, `R` = `p.stats.roundsPlayed`):

| Stat | Formula | Field source |
| --- | --- | --- |
| K / D / A | `p.stats.kills` / `deaths` / `assists` | E11 `players[].stats` |
| ACS | `p.stats.score / R`, rounded | E11 |
| HS% | Σ headshots ÷ Σ (head + body + leg) over every `roundResults[].playerStats[]` whose `subject` is `p`, across all its `damage[]` entries | E11 |
| ADR | Σ `damage[].damage` over the same entries ÷ `R` | E11 |
| Result, score | `teams[]`: `won`, `roundsWon` for `p.teamId` | E11 (confirmed in S2) |
| Map, agent, rank | `matchInfo.mapId` → valorant-api.com `/v1/maps` (`mapUrl`); `p.characterId` → `/v1/agents` (compare lowercased); `p.competitiveTier` → the last entry of `/v1/competitivetiers` | Confirmed in S2 |
| RR ± | E12 entry with the same `MatchID` | E12 |

`p.stats` can be null (valapidocs); such a player shows as "—" on the scoreboard. A match with `matchInfo.isCompleted` false is retried on the next poll, not posted.

## HenrikDev integration

The followed tier runs on a free HenrikDev key. It is spent through a budget so 10 friends playing at once stay under the limit.

**Key:** generate it on the [HenrikDev dashboard](https://api.henrikdev.xyz/dashboard/) → API Keys → Generate New Key ([auth docs](https://docs.henrikdev.xyz/general/auth.md)). Store it as `HENRIK_API_KEY` in `.env` and send it in the `Authorization` header. Register it with `addSecret` so `log.ts` redacts it. Without the key, `/recap join` is off and only the linked tier works.

| # | Path on `https://api.henrikdev.xyz` | Use |
| --- | --- | --- |
| H1 | `/valorant/v2/account/{name}/{tag}` | `/recap join`: Riot ID → `puuid`, `region` |
| H2 | `/valorant/v4/by-puuid/matches/{region}/pc/{puuid}?size=1` | Poll: newest match with full player stats (`score`, `kills`, `deaths`, `assists`, `headshots`, `bodyshots`, `legshots`, `damage.dealt`) |
| H3 | `/valorant/v2/by-puuid/mmr-history/{region}/pc/{puuid}` | RR: entry with the same `match_id` → `last_change`, `rr`, `tier` |

Sources: [H1](https://docs.henrikdev.xyz/api-reference/valorant/get-account-v2.md), [H2](https://docs.henrikdev.xyz/api-reference/valorant/get-matches-by-puuid-v4.md), [H3](https://docs.henrikdev.xyz/api-reference/valorant/get-mmr-history-by-puuid-v2.md).

**Budget.** The README gives a Basic key 30 requests a minute ([repo](https://github.com/Henrik-3/unofficial-valorant-api)). Since v4, the Riot fetches HenrikDev makes for you count too ([rate limiting](https://docs.henrikdev.xyz/general/rate-limiting)), so one H2 poll can cost up to 3. Rules:

- One shared budget of 20 units per minute; a poll that would exceed it waits.
- Read `X-RateLimit-Remaining` and `Retry-After` on every answer and trust them over the local count.
- H3 only for competitive matches, and only once a new `match_id` appears.
- ACS, HS% and ADR come from H2's stats with the same formulas as E11. Rounds = length of the match's `rounds` array.

## tracker.gg (rejected)

The endpoint seen in the browser is `GET https://api.tracker.gg/api/v2/valorant/standard/profile/riot/{name}%23{tag}`, with a `matches` sibling. It is not used, for three reasons:

1. **Not permitted.** Asked about this exact `api.tracker.gg/api/v2/valorant/standard/matches/riot/...` URL, Tracker Network replied "We don't allow anyone to use our internal API". Their developer FAQ says the same about any TRN endpoint not in their public docs ([forum thread](https://feedback.tracker.gg/t/valorant-api-inquiry/28078)).
2. **Not reachable unattended.** The browser call works because it carries tracker.gg cookies and Cloudflare clearance. Commercial scrapers of the site recommend residential proxies ([Apify](https://apify.com/aiweb/trackergg-scraper?fpr=p2hrc6)).
3. **Not needed.** Tracker.gg gets its Valorant data from Riot. E11 or H2 give the same per-match numbers first-hand. The only thing missing is tracker.gg's own "Tracker Score".

Revisit only if Tracker Network adds Valorant to its [public API](https://github.com/TrackerNetwork/TRN.Developers).

## Roster & consent

Everyone on the roster put themselves there; the owner can remove people but never add them. Linking for the shop does not count as agreeing to public match recaps.

| Command | Who | Effect |
| --- | --- | --- |
| `/recap on` | Owner or a linked member | Joins the linked tier. On by default for the owner, off for members |
| `/recap off` | Anyone on the roster | Stops recaps for them; keeps the entry so `on` restores it |
| `/recap join riot_id:` | A server member who is not linked | Resolves the Riot ID with H1, adds a followed entry, and tells the owner in the channel |
| `/recap leave` | A followed member | Deletes their entry |
| `/recap list` | Anyone | Roster: Discord name, Riot ID, tier, trigger |
| `/recap remove user:` | Owner only | Deletes anyone's followed entry, or switches a linked member to off |

**Rules**

- One roster entry per Discord user and per PUUID, the same rule as the accounts registry. A Riot ID already on the roster under someone else is refused.
- At most 15 followed entries. That is the HenrikDev budget's ceiling at the poll intervals above.
- `/recap join` explains first, in an ephemeral reply, that their match stats will be posted in the channel. It needs a confirm button.
- When a linked member unlinks, their recap entry goes with them.
- The Riot ID shown is re-read from E11/H2 on each match, since players rename.

## Recap message

One embed per match, in `RECAP_CHANNEL_ID` (falls back to the shop channel). It is posted as soon as the stats are in, then edited once when a late RR change arrives. Its text mentions and pings every roster member who played, through the roster's Discord user ↔ PUUID link, and nobody else; each of their lines starts with their Discord mention. The RR edit doesn't ping again (Discord doesn't notify on edits).

```text
Victory 13–9 · Ascent · Competitive · 38 min        (green; red on a loss, grey on a draw)

Tyler    Jett   21/14/5   ACS 268  HS 24%  ADR 162   +21 RR → Gold 2 (45)
friend1  Sova   15/12/9   ACS 201  HS 19%  ADR 131   +19 RR

Your team                         Enemy team
▶ Jett    Tyler   21/14/5  268    Raze   abc    18/16/3  240
▶ Sova    friend1 15/12/9  201    ...
  Omen    rando1  ...
```

- **Title:** result and score for the tracked players' team, map, queue, duration. If tracked players were on both teams, the title says "Split" and the embed is grey.
- **Description:** one line per tracked player in the match, highest ACS first. RR shows "…" until it is known; after 15 min without it, drop the field.
- **Two fields**, one code block per team, sorted by ACS. Tracked players get a `▶`. Names are cut to 12 characters, so each field stays far under Discord's 1,024-character limit.
- **Footer:** match ID (short) and "late" for sweep finds.

**Dedup and grouping.** `postedMatches` in state maps match ID → Discord message ID, keeping the newest 500. Whoever's poll finds a match first builds the recap for **every** roster member in it. Later polls see the ID and only fill in missing RR by editing the message. A match is recorded only after Discord accepts the post.

## Fit into daily-drip

The recap sits beside the shop and reuses its HTTP client, auth, run lock, catalog and notifier. Written against `main` at commit `26f7cf6`; check `dev` for anything newer before starting. Per `CLAUDE.md`, the main spec gets a "Match recap" section once this ships.

**New modules**

| File | Holds |
| --- | --- |
| `src/riot/matches.ts` | E10–E12: fetch + parse, typed errors |
| `src/henrik.ts` | H1–H3, the 20-units-a-minute budget, key redaction |
| `src/recap.ts` | Pure: E11 or H2 → `MatchRecap`, the formulas, team result |
| `src/roster.ts` | Pure: roster entries and the consent rules, styled after `accounts.ts` |
| `src/sessions.ts` | In-memory session cache, 50 min TTL, for the owner (cookie) and members (refresh token) |
| `src/recapScheduler.ts` | Presence tracking, per-entry poll timers, the 04:00 sweep |
| `src/notify/recapMessage.ts` | Embed builder, and the RR edit |

**Changed modules**

- `src/riot/store.ts`: export `gameHeaders`.
- `src/members.ts`: split the session part out of `fetchMemberShop`, so recap and shop share one refresh path.
- `src/notify/discord.ts`: `GuildPresences` intent, a `PresenceUpdate` hook, send and edit for recap messages.
- `src/commands.ts`: the `/recap` subcommands.
- `src/catalog.ts`: maps, agents and competitive tiers from valorant-api.com, cached per game version like the skins.
- `src/config.ts` + `.env.example`: `HENRIK_API_KEY` (optional), `RECAP_CHANNEL_ID` (optional snowflake), `RECAP_QUEUES` (default `competitive,unrated,swiftplay`).
- `src/state.ts`: a `recap` block, defaulted in `loadState` the way `accounts` is.
- `src/main.ts`: wiring; README: commands and the privacy note.

**State addition**

```text
recap: {
  roster: { [discordUserId]: { tier: "linked" | "followed", enabled, trigger: "presence" | "poll",
                               puuid, riotName, region, addedAt } },
  postedMatches: [ { matchId, messageId, postedAt, rrPending: puuid[] } ],   // newest 500
  lastSeenMatch: { [puuid]: matchId }
}
```

No token, key or session goes into `state.json`; sessions live in `src/sessions.ts` memory only.

## Error handling

A recap failure never touches the shop: its errors stay in the recap scheduler, and a missed match is caught by the next poll or the sweep. Shared conditions (rate limit, Cloudflare block) pause recap polling the same way they stop a member round today.

| Symptom | Action |
| --- | --- |
| E10/H2 shows no new match after "Stopped" | Expected right after a match; the +2/+5/+10 polls cover it |
| E11 404, or `isCompleted` false | Retry on the next poll; give up on that ID after 30 min |
| E10–E12 401 or `BAD_CLAIMS` | Drop the cached session, get a new one once, retry; a second failure ends that poll |
| Owner's cookie dead, or a member's `invalid_grant` | The shop's existing alert flow handles it; recap polling for that person pauses until it recovers |
| Riot 429 or Cloudflare block | Pause all `pd` recap polls until `Retry-After` (default 1 h); no alert, since the shop alerts already cover it |
| E10 for another PUUID refused (S2 path) | Switch that entry to HenrikDev for good and log once |
| HenrikDev 429 | Wait for `Retry-After`; the budget absorbs it |
| HenrikDev 401/403 | Alert the owner once ("HenrikDev key missing or invalid"); pause the followed tier |
| H1 finds no account on `/recap join` | Ephemeral "No Riot account with that ID"; nothing stored |
| Discord post or edit fails | Retry 3 times with backoff; the match is not marked posted, so the next poll tries again |
| valorant-api.com down | Post with raw IDs where a name is missing |

## Spikes & acceptance

Four spikes in `scripts/recap-spike.ts` come before any module. Each answers one open question, and its answer goes into Unknowns below.

1. **S1, presence.** With the intent on, log every `PresenceUpdate` for the owner over a real session: activity `name`, `type`, `applicationId`. Does "Playing VALORANT" stay up between matches, and does it end within a minute of quitting?
2. **S2, pd.** With the owner's session: E10, E11 and E12 for the owner's last match, then print the recap fields and compare them with the in-game scoreboard. Check the `teams[]` and map/agent/tier field names. Then E10 for one consenting friend's PUUID: 200 or refused?
3. **S3, HenrikDev.** H1 for a friend's Riot ID, then H2 and H3. Log the rate-limit headers and the cost of a cold H2 against a warm one.
4. **S4, session reuse.** Reuse one owner session for E10 at 0, 30 and 55 min. Confirm when it stops working, and that E1 ran once.

**Acceptance** (on the home server, with real accounts)

- [ ] Owner plays a competitive match: a recap is posted within 6 min of its end, and K/D/A, ACS and RR change match the in-game screens.
- [ ] Owner and a linked member in one party: one recap, both marked, both with RR.
- [ ] A followed friend's match, without the owner: recap within 10 min, via HenrikDev.
- [ ] Restarting the bot mid-session posts nothing twice.
- [ ] `/recap off` stops that person's recaps; `/recap leave` deletes a followed entry; a non-owner can't run `/recap remove`.
- [ ] One hour with nobody playing: debug logs show no E10–E12 or H1–H3 calls.
- [ ] A 3-hour session: the owner's E1 ran at most 4 times.
- [ ] The shop still posts on time on a day with recaps.
- [ ] Logs contain no token, cookie or HenrikDev key.
- [ ] Unit tests: the formulas on a fixture E11 and a fixture H2, team result incl. "Split", dedup and grouping, the roster rules, the budget.

## Build status

Built on `dev` and deployed with `RECAP=off` (2026-11-25). Unit tests cover the formulas on an E11 and an H2 fixture (both give identical numbers), the team result incl. split, dedup and grouping, the roster rules, the budget, the scheduler's timing and the `/recap` flows.

| Module | Holds |
| --- | --- |
| `src/recap.ts` | E11 and H2 → `MatchRecap`, team result, ACS sort |
| `src/riot/matches.ts` | E10–E12 with typed errors (`MatchNotReadyError` for E11's 404) |
| `src/henrik.ts` | H1–H3, the 20-units-a-minute budget following HenrikDev's own window |
| `src/roster.ts` | Roster entries and the consent rules |
| `src/sessions.ts` | In-memory sessions, 50 min |
| `src/recapScheduler.ts` | Presence and poll timers, the 04:00 sweep, per-source pauses |
| `src/recapPoll.ts` | One poll: new matches, details, grouping, RR fill-in by edit (not in the module list above) |
| `src/notify/recapMessage.ts` | The embed |
| `src/recapCommands.ts` | `/recap` and the join confirmation |

**Differences from the plan above**

- **`RECAP=on|off`** (default off). With `on`, the bot asks for the Presence Intent; if Discord refuses it (close code 4014: not switched on in the Developer Portal), the bot logs how to fix it and starts without recaps, so the shop is never taken down.
- **The shop's owner session is put in the recap cache** after each shop run, so the first recap poll of the day needs no extra sign-in.
- **A followed friend's sweep checks only their newest match** (H2 `size=1`), not the last 5: bigger pages cost more HenrikDev units.
- **RR still pending when the bot restarts is dropped:** the post stays as it is, with "…", because the recap is only kept in memory.
- **`/recap trigger mode:`** lets someone without activity status switch to polling every 20 min.

To turn recaps on: switch on the Presence Intent (Developer Portal → Bot → Privileged Gateway Intents), set `RECAP=on` in the server's `.env`, and redeploy. While on, the owner's presence changes are logged for S1.

## Unknowns & sources

The design rests on five points nobody has checked yet; each has a spike.

| Item | Status | Settled by |
| --- | --- | --- |
| "Playing VALORANT" spans a whole session, not one match | Inferred | S1 |
| E11 field names for `teams[]`, map, agent, tier | **Confirmed 2026-11-25 (S2):** `matchInfo.queueID` (capital ID), `mapId`, `isCompleted`, `gameLengthMillis`; `teams[]`: `teamId`, `won`, `roundsWon`, `roundsPlayed`; `players[]`: `subject`, `teamId`, `partyId`, `characterId`, `competitiveTier`, `stats` {`score`, `roundsPlayed`, `kills`, `deaths`, `assists`}; `roundResults[].playerStats[].damage[]`: `receiver`, `damage`, `headshots`, `bodyshots`, `legshots`. E10 `History[]`: `MatchID`, `GameStartTime`, `QueueID`; E12 `Matches[]` has `QueueID` too | S2 |
| E10 accepts another player's PUUID with the owner's session | Unknown; docs are silent | S2 |
| HenrikDev cost per cold H2 and the Basic key's current limit | **Measured 2026-11-25 (S3):** 30 units per 60 s (`x-ratelimit-limit`, `-remaining`, `-reset`). H1 cost 3 units, H2 2 cold and 1 warm, H3 2. H2's per-player totals gave exactly the same K/D/A, ACS, HS% and ADR as E11 for the same match. H2: `metadata` {`match_id`, `map` {`id`, `name`}, `queue` {`id`}, `started_at`, `game_length_in_ms`, `is_completed`}; `players[]` {`puuid`, `name`, `tag`, `team_id`, `party_id`, `agent` {`id`}, `tier` {`id`}, `stats` {`score`, `kills`, `deaths`, `assists`, `headshots`, `bodyshots`, `legshots`, `damage` {`dealt`}}}; `teams[]` {`team_id`, `won`, `rounds` {`won`, `lost`}}. H3 `data.history[]`: `match_id`, `last_change`, `rr`, `tier` {`id`} | S3 |
| An access token still works at 55 min | About 1 hour per valapidocs | S4 |

**Risks**

- Same as the shop: Riot can change `pd` without notice, and HenrikDev is a free third-party service that can change limits or go away. The linked tier keeps working without it.
- Recaps post friends' stats in a channel. That is why every entry is self-added, and the owner can't add anyone.

**Sources**

- valapidocs: [match history](https://valapidocs.techchrism.me/endpoint/match-history), [match details](https://valapidocs.techchrism.me/endpoint/match-details), [competitive updates](https://valapidocs.techchrism.me/endpoint/competitive-updates), [common components](https://techchrism.github.io/valorant-api-docs/common-components.html)
- HenrikDev: [auth](https://docs.henrikdev.xyz/general/auth.md), [rate limiting](https://docs.henrikdev.xyz/general/rate-limiting), [account v2](https://docs.henrikdev.xyz/api-reference/valorant/get-account-v2.md), [matches v4 by PUUID](https://docs.henrikdev.xyz/api-reference/valorant/get-matches-by-puuid-v4.md), [MMR history v2 by PUUID](https://docs.henrikdev.xyz/api-reference/valorant/get-mmr-history-by-puuid-v2.md), [README](https://github.com/Henrik-3/unofficial-valorant-api)
- Discord: [privileged intents under 10,000 users](https://support-dev.discord.com/hc/articles/4404772028055)
- Tracker Network: [internal API not allowed](https://feedback.tracker.gg/t/valorant-api-inquiry/28078), [public API](https://github.com/TrackerNetwork/TRN.Developers)
- [tyler-void/daily-drip](https://github.com/tyler-void/daily-drip) at `26f7cf6`: `src/accounts.ts`, `src/members.ts`, `src/riot/store.ts`, `src/riot/auth.ts`, `src/state.ts`, `src/notify/discord.ts`, `src/main.ts`, and the main spec's Accounts section
