# Admin panel rework — design

## Problem

Current admin panel (`admin.html`, `src/admin.ts`, `worker/routes/admin.ts`) has several issues:
1. History table only shows admin-granted packs (`WHERE p.source = 'admin'`), capped at 20, with no source/tier-is-there-but-source-missing breakdown, and no indication of *which* admin granted a pack.
2. A "Todos los usuarios" paginated list duplicates what direct search already does.
3. The "Dar blíster" heading is redundant noise.
4. The header (back button + logout) is plain `<a class="btn">`/`<button class="btn">`, not the `page-header` pattern used on every other page (trade.html, collection.html, etc.).
5. Admin auth is a single shared password with no per-admin identity, so there's no way to say *who* granted a pack.

## Design

### 1. Admin identity

Admin login form gets a required "Nombre" text input alongside the password.

- `worker/lib/jwt.ts`:
  - `signAdminSession(secret: string, adminName: string): Promise<string>` — signs `{ role: "admin", adminName }`.
  - `verifyAdminSession(token: string, secret: string): Promise<{ adminName: string } | null>` — returns the payload's `adminName` on success (typed as `string`, defaulting to `"Admin"` if the field is missing/invalid — old tokens issued before this change), `null` on failure. Callers that only checked truthiness now check `!== null`.
- `worker/middleware/auth.ts`: `requireAdmin` sets `c.set("adminName", result.adminName)` (add `adminName: string` to its `Variables` type) instead of just calling `next()` on a boolean.
- `worker/routes/admin.ts`:
  - `POST /login` body gains `name?: string`. Validate name first: if missing/empty (after `.trim()`), return `400 { error: "Name required" }`. Then validate password as today (`401 { error: "Invalid password" }`). Passes the trimmed `body.name` to `signAdminSession`.
  - `POST /grant-packs` reads `c.get("adminName")` and inserts it as `granted_by` on every row it creates.

### 2. Schema: track who granted a pack

New migration `migrations/0011_pack_granted_by.sql`:

```sql
ALTER TABLE packs ADD COLUMN granted_by TEXT;
```

Nullable — only ever populated for `source = 'admin'` rows; `reward` rows leave it `NULL`.

### 3. History: all sources, 25 rows, admin attribution

`worker/routes/admin.ts` `GET /history`:

```sql
SELECT p.id, p.user_id AS userId, u.username, p.tier AS tier, p.source AS source,
       p.granted_by AS grantedBy, p.created_at AS createdAt
FROM packs p JOIN users u ON u.twitch_id = p.user_id
ORDER BY p.created_at DESC LIMIT 25
```

(No `WHERE` clause — all sources included. Rows beyond 25 are not returned/rendered; no pagination.)

`src/admin.ts`:
- `HistoryRow` gains `source: string` and `grantedBy: string | null`.
- `renderHistory`: add a "Fuente" column showing `source` verbatim (`admin` or `reward`). The "Usuario" column shows `${h.grantedBy} -> ${h.username}` when `h.source === "admin"` (grantedBy is always non-null for admin rows going forward; treat a legacy `null` as `"Admin"`), otherwise just `h.username`.

### 4. Remove "Todos los usuarios"

Delete:
- `admin.html`: the entire "Todos los usuarios" `<div>` block (table, thead, `#all-users-body`, prev/next buttons).
- `src/admin.ts`: `renderAllUsers`, `loadAllUsers`, `currentUsersPage`, the `users-prev-btn`/`users-next-btn` listeners, and the `loadAllUsers(1)` calls in `login()`/`init()`.
- `worker/routes/admin.ts`: the `GET /users/all` route.
- Any test coverage in `test/routes/admin.test.ts` exercising `/users/all` is removed too (grep before deleting to catch all references).

Direct search (`#search-input` → `GET /users?q=`) is unchanged and remains the only way to pick a user.

### 5. Remove "Dar blíster" heading

Delete the `<h2>Dar blíster</h2>` line from `admin.html`. The input/select/button block beneath it is untouched.

### 6. Header parity

Replace admin.html's current header buttons:

```html
<a class="btn" href="/collection.html">Volver a Colección</a>
<button class="btn" id="logout-btn" style="margin-left: 0.5rem;">Cerrar sesión</button>
```

with the same `page-header` structure used in `trade.html`/`collection.html`:

```html
<header class="page-header">
  <div class="page-header-actions">
    <a class="btn btn-icon" href="/collection.html">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
      </svg>
      Volver a Colección
    </a>
  </div>
  <div class="page-header-user">
    <button class="icon-btn" id="logout-btn" type="button" title="Cerrar sesión" aria-label="Cerrar sesión">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
    </button>
  </div>
</header>
```

No `#user-avatar`/`#user-name` elements — the admin session has no Twitch identity, so `initUserHeader()` is not used here. `src/admin.ts`'s existing `logout()` function (calls `POST /api/admin/logout`, shows login view) stays wired to `#logout-btn` unchanged; only the markup around it changes.

This header sits above the existing `<div class="container">`, matching the other pages' layout (header outside the padded container).

## Out of scope

- No change to `tier` values (`gratis`/`apoyo`) or the grant-packs quantity/tier UI beyond removing its heading.
- No change to the search-by-name flow itself.
- No multi-admin management (no admin list/roles table) — `adminName` is free-text entered at login each time, not tied to an account.

## Testing

- `test/routes/admin.test.ts`: update/add coverage for `POST /login` requiring `name`, `POST /grant-packs` writing `granted_by`, `GET /history` returning all sources with `source`/`grantedBy` fields and respecting the 25-row cap. Remove the `/users/all` test(s).
- Manual: log in with a name, grant a pack, confirm history shows `"{name} -> {receiver}"` with source `admin`; confirm a `reward`-sourced pack (if any test data exists) shows plain username with source `reward`; confirm header buttons visually match collection.html; confirm "Todos los usuarios" section and "Dar blíster" heading are gone.
