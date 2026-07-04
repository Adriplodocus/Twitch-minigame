# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Twitch channel-points minigame: viewers redeem a channel-point reward, get a virtual pack of Pokémon cards, and build a collection. Runs as a Cloudflare Worker (Hono API + D1) serving a multi-page vanilla TypeScript/Vite frontend. Twitch OAuth for viewer login, Twitch EventSub webhook for reward redemptions, an OBS browser-source overlay for on-stream pack reveals, and a small admin panel.

## Commands

- `npm run dev` — Vite dev server (frontend + Worker via `@cloudflare/vite-plugin`)
- `npm run build` — `vite build` (outputs `dist/`)
- `npm run deploy` — build + `wrangler deploy`
- `npm run test:worker` — Workers-runtime tests (Miniflare/D1), covers `worker/**` and `test/**`
- `npm test` — plain Node tests (`vitest.config.ts`), covers `src/**/*.test.ts` and `tools/**/*.test.ts`
- Single test file: `npx vitest run <path>` (add `--config vitest.workers.config.ts` for worker/D1 tests, otherwise the default `vitest.config.ts` is used)
- `npm run catalog:build` — regenerates the card catalog from `tools/catalog/cards.csv` into `catalog.json` + `tools/catalog/seed-cards.sql`

Local setup, D1 migration commands, and Twitch app credential wiring are documented in `README.md` — read it before touching auth/EventSub/catalog seeding.

## Architecture

### Two test configs, two runtimes

Tests are split by which JS runtime they need to run in — always match the file to its config:
- `vitest.workers.config.ts`: runs inside actual Workers runtime (Miniflare) via `@cloudflare/vitest-pool-workers`, with D1 migrations from `migrations/` auto-applied per test (`test/apply-migrations.ts`). Use for anything touching `c.env.DB`, Hono routes, or worker-only APIs. Covers `worker/**/*.test.ts` and `test/**/*.test.ts`.
- `vitest.config.ts`: plain Node environment. Covers `src/**/*.test.ts` (frontend logic, DOM-string rendering) and `tools/**/*.test.ts` (catalog build CLI). Nothing here has D1/Worker bindings.

### Backend (`worker/`)

Hono app (`worker/index.ts`) mounting route groups under `/api/*` plus `/webhook/*`:
- `routes/auth.ts` — viewer Twitch OAuth login/callback + a separate broadcaster OAuth flow (`/broadcaster-login`, `/broadcaster-callback`) used once to register the EventSub subscription (needs a public HTTPS callback, can't run against localhost).
- `routes/webhook.ts` — Twitch EventSub webhook (`/webhook/eventsub`); verifies HMAC signature via `lib/eventsub.ts` before creating a pack for the redeeming user.
- `routes/collection.ts` — viewer's cards + opening packs (`lib/packs.ts` does the weighted random draw) + broadcasting an opened pack (feeds the overlay).
- `routes/trade.ts` — card trade offers between users (create/accept/decline/cancel, pending-count polling).
- `routes/admin.ts` — separate admin session (its own login/cookie, see below), granting packs manually, viewing pack/grant history.
- `routes/overlay.ts` — polling endpoint (`?since=<cursor>`) the OBS overlay uses to fetch newly broadcast pack-opening events.

Two independent auth schemes, both JWT-in-cookie via `worker/lib/jwt.ts`, enforced by `worker/middleware/auth.ts`:
- `requireAuth` — viewer session (`session` cookie), populated after Twitch OAuth.
- `requireAdmin` — admin session (`admin_session` cookie), a shared `ADMIN_PASSWORD` login that also carries an admin display name (used to attribute manual pack grants in history).

`worker/lib/packs.ts` is the pack-odds engine: rarity weights and shiny chance vary by `PackTier` ("gratis" vs "apoyo"/paid), plus a further weight split for special `Category` buckets (`inicial`/`mega`/`gmax`) carved out of each rarity's budget. Changing drop rates means editing `RARITY_WEIGHTS_BY_TIER` / `SHINY_CHANCE_BY_TIER` / `CATEGORY_WEIGHTS` here, not scattering constants elsewhere.

`wrangler.jsonc`'s `assets.run_worker_first: ["/api/*", "/webhook/*"]` is what routes those paths to the Worker instead of being served as static assets — anything outside that needs a new entry there too.

### Frontend (`src/`, one entry per page)

No framework — plain TypeScript modules, one per HTML page, each bootstrapped from a `<script type="module">` tag. Vite multi-page build config lives in `vite.config.ts` (`rollupOptions.input`); adding a new page means adding both the `.html` file and an entry there.

- `index.html` / `login.ts` — landing/login
- `collection.html` / `collection.ts` — viewer's own collection, pack opening
- `trade.html` / `trade.ts` — trade offers UI
- `offers.html` / `offers.ts` — pending offers list
- `album.html` / `album.ts` + `album-book.ts` — per-generation "album" view of the full catalog
- `admin.html` / `admin.ts` — admin login, manual pack grants, history
- `overlay.html` / `overlay.ts` — OBS browser-source source; polls `routes/overlay.ts` and animates card reveals over stream

Shared modules: `api.ts` (typed `fetch` wrapper for `/api/*`, redirects to `/` on 401), `card.ts` (card HTML rendering shared by collection/trade/album/overlay — including rarity foil/shiny sparkle VFX), `card-tilt.ts` (3D tilt-on-hover effect), `user-header.ts`, `generations.ts` (static list of Pokémon generations/regions), `trade-link.ts`.

`card.ts`'s `renderCardHtml` is the single source of truth for card markup/VFX classes (`foil`, `shiny`, `tiltable`) — every page that shows cards renders through it, so VFX or markup changes belong there, not duplicated per page.

### Card catalog pipeline

The catalog is generated data, not hand-authored: `tools/catalog/cards.csv` (source list) → `npm run catalog:build` → `catalog.json` (served to the frontend) + `tools/catalog/seed-cards.sql` (applied to D1 via `wrangler d1 execute`). `build-catalog.ts` derives `Category` (inicial/mega/gmax) and rarity floors from hardcoded species name lists — see the comments there before changing rarity/category logic, some floor rules rely on other invariants (e.g. starter final evolutions already reaching epic rarity on their own stats). Artwork PNGs live in `public/cards/`.

### Migrations

Sequential numbered SQL files in `migrations/`, applied via `wrangler d1 migrations apply` (see README for local/remote flags). `vitest.workers.config.ts` auto-applies all of them before worker tests run, so schema changes are exercised by the test suite without a manual step.
