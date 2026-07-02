# Colección de Cartas Twitch

## Setup

1. `npm install`
2. Create a D1 database: `npx wrangler d1 create twitch-cards-db`, paste the returned `database_id` into `wrangler.jsonc`.
3. `npx wrangler d1 migrations apply twitch-cards-db --local` (and `--remote` after first deploy) — use the D1 database name from `wrangler.jsonc` (`twitch-cards-db`), not the Worker's project name.
4. Copy `.dev.vars.example` to `.dev.vars` and fill in Twitch app credentials (create the app at https://dev.twitch.tv/console/apps) and a random `JWT_SECRET`/`TWITCH_EVENTSUB_SECRET`.
5. Design card artwork, drop PNGs into `public/cards/`, list them in `tools/catalog/cards.csv`, then run `npm run catalog:build` and apply `tools/catalog/seed-cards.sql` with `wrangler d1 execute`.
6. `npm run dev` to develop locally.

## Deploy

1. `npm run build`
2. `npx wrangler deploy`
3. Update the Twitch app's OAuth redirect URLs to the deployed domain.
4. Log in once as the broadcaster via `/api/auth/broadcaster-login` to register the EventSub subscription (requires the deployed HTTPS URL — Twitch cannot call back to localhost).

## Testing

- `npm run test:worker` — Workers-runtime tests (D1, routes)
- `npm test` — plain Node tests (catalog CLI tool)
