# Admin grant-packs panel — design spec

## Goal

A password-gated admin page where the streamer can manually grant blísters
(pack rows) to any registered user — e.g. for subs, bit donations, or other
manual rewards outside the Twitch channel-points reward flow.

## Auth

Single shared password, stored as a Worker secret `ADMIN_PASSWORD` (added to
`.dev.vars` / `.dev.vars.example` locally, set via `wrangler secret put
ADMIN_PASSWORD` in production).

- `POST /api/admin/login` — body `{ password: string }`. Compares against
  `env.ADMIN_PASSWORD`. On match, signs an admin JWT via a new
  `signAdminSession`/`verifyAdminSession` pair in `worker/lib/jwt.ts` (payload
  `{ role: "admin" }`, `HS256`, reuses `JWT_SECRET`, 30-day expiry) and sets it
  as an httpOnly, secure, `SameSite=Lax` cookie `admin_session`. Wrong password
  → 401.
- `POST /api/admin/logout` — clears the `admin_session` cookie.
- New `requireAdmin` middleware in `worker/middleware/auth.ts` (mirrors
  `requireAuth`): reads `admin_session` cookie, verifies it, 401 if
  missing/invalid, else `next()`. Applied to all other `/api/admin/*` routes.

This is a single global session, not tied to a Twitch account — completely
separate from the existing player `session` cookie/JWT.

## User lookup

- `GET /api/admin/users?q=<text>` (requireAdmin) —
  `SELECT twitch_id, username, avatar_url FROM users WHERE username LIKE ?
  ORDER BY username LIMIT 10`, bound to `%<text>%`. Returns `{ users: [...] }`.
- Only finds users who already have a row in `users` (i.e. have logged in via
  Twitch OAuth at least once, or already redeemed the channel-points reward).
  Users who have never touched the site cannot be granted packs — out of
  scope to fetch/create arbitrary Twitch accounts on the fly.

## Granting packs

- `POST /api/admin/grant-packs` (requireAdmin) — body
  `{ twitchId: string, quantity: number }`. Validate `quantity` is an integer
  between 1 and 50 (guards against fat-fingering a huge number; 400 if out of
  range). Inserts `quantity` rows via `c.env.DB.batch`, one
  `INSERT INTO packs (user_id, source) VALUES (?, 'admin')` per pack — same
  one-row-per-pack pattern `worker/routes/webhook.ts` already uses, just with
  the new `source` column set explicitly. Returns `{ ok: true }`.

## Schema change

New migration `migrations/0005_pack_source.sql`:
```sql
ALTER TABLE packs ADD COLUMN source TEXT NOT NULL DEFAULT 'reward'
  CHECK (source IN ('reward', 'admin'));
```
Existing webhook insert (`worker/routes/webhook.ts`) is untouched — it keeps
inserting without specifying `source`, so it defaults to `'reward'`.

## History

- `GET /api/admin/history` (requireAdmin) — last 20 admin-granted packs:
  ```sql
  SELECT p.id, p.user_id, u.username, p.created_at AS createdAt
  FROM packs p JOIN users u ON u.twitch_id = p.user_id
  WHERE p.source = 'admin'
  ORDER BY p.created_at DESC LIMIT 20
  ```
  Returns `{ history: [...] }`. Grouped by nothing — each row is one pack, so
  a single "gave 5 packs" action shows as 5 rows with the same timestamp
  (acceptable; no batch-grouping UI needed).

## Frontend

New `admin.html` + `src/admin.ts`, added to `vite.config.ts`'s
`rollupOptions.input` (same pattern as `collection`/`trade`/`album`).

- **Login view**: password `.input` + `.btn` "Entrar". On submit, POST to
  `/api/admin/login`; on 401 show inline error; on success switch to the
  panel view (no page reload).
- **Panel view** (shown after successful login, or immediately if a valid
  `admin_session` cookie already lets a probe request through — the page
  calls `GET /api/admin/history` on load; a 401 response means show the
  login view instead):
  - Search `.input` (debounced ~250ms) → `GET /api/admin/users?q=`, renders
    a click-to-select list below it.
  - Selected user shown as a small chip (avatar + username) with an "x" to
    clear selection.
  - Quantity `.input type=number`, default `1`, min `1`, max `50`.
  - "Dar blíster(s)" `.btn`, disabled until a user is selected.
  - Clicking it opens a small custom confirm modal (styled like the existing
    pack-reveal overlay in `src/collection.ts` — a fixed-position dark
    backdrop with a centered `.card`, NOT the native `window.confirm()`):
    "¿Dar {quantity} blíster(s) a {username}?" with "Confirmar" / "Cancelar"
    buttons. Confirming calls `POST /api/admin/grant-packs`, shows a success
    message, clears the selection, and refreshes the history table.
  - History table below: username, quantity-as-rows-or-just-timestamp columns
    (username | fecha), newest first.
  - "Cerrar sesión" `.btn` that calls `/api/admin/logout` and returns to the
    login view.

No link to `admin.html` is added from any other page (not discoverable via
UI navigation) — accessed by typing the URL directly.

## Out of scope

- No per-admin accounts/usernames — one shared password for the single admin
  (streamer).
- No rate limiting / lockout on failed login attempts.
- No ability to revoke/undo a granted pack.
- No creating a `users` row on the fly for a Twitch account that has never
  logged in.
- No UI navigation link to the admin page from public pages.

## Verification

- Manual: log in with wrong password (expect 401 + inline error), correct
  password (expect panel), search an existing username (expect match),
  search nonsense (expect empty list), grant 1 and grant 5 packs to a test
  account, confirm they show up as pending packs on that account's
  `/collection.html` and as rows in the history table with `source='admin'`
  in D1, log out and confirm the panel is gated again.
- `test/routes` (or a new `test/routes/admin.test.ts` following the existing
  pattern in that directory): cover login success/failure, requireAdmin
  rejecting missing/invalid cookies, user search, grant-packs quantity
  validation (0, 51, negative → 400), and history ordering.
