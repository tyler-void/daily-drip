# daily-drip

Discord bot that posts the owner's daily Valorant shop after each reset. The spec, `Valorant Store Checker — Spec.md`, is the source of truth: read it first, and update it when behaviour changes.

**Current task:** `docs/step-6-deploy.md` (Docker and deploy on `home-server`).

- **Runtime:** Bun 1.3.14, TypeScript run directly. Erasable syntax only (`erasableSyntaxOnly`, `.ts` import extensions), so falling back to Node stays cheap; Bun-specific APIs go only in `src/http.ts`.
- **Commands:** `bun install`, `bun test`, `bun run typecheck`, `bun start` (needs `.env` and `config/riot-cookie`).
- **Branches:** work on `dev`. `main` is what Portainer deploys; merge into it only with the owner's OK.
- **Secrets:** the Riot cookie (`config/riot-cookie`, and the rotated jar in `data/state.json`) gives full account access and gets around 2FA. Never print, commit, paste or upload it, or the Discord token. `.env`, `config/` and `data/` are gitignored. All output goes through `src/log.ts` (`redact`).
- **One running instance per cookie and per bot token:** two would split the cookie rotation, and both would answer the slash commands.
