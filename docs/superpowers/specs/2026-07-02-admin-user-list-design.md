# Admin user list — design spec

## Goal

Add a paginated "all users" list to the existing admin panel (`admin.html`),
alongside the search-based flow already shipped. Each row shows a username
and a one-click "+1 blíster" button so the streamer can grant a single pack
without typing anything, in addition to the existing search-and-select flow
for granting arbitrary quantities.

## Scope

This extends the admin panel shipped in
`docs/superpowers/specs/2026-07-02-admin-grant-packs-design.md` /
`docs/superpowers/plans/2026-07-02-admin-grant-packs.md`. It does not change
the existing search box, quantity input, or history table — those stay
exactly as they are. It adds a new section and a new read endpoint; the
existing `POST /api/admin/grant-packs` is reused unchanged.

## Backend

New route in `worker/routes/admin.ts`:

```
GET /api/admin/users/all?page=<n>   (requireAdmin, same middleware as other admin routes)
```

- `page` is 1-indexed, defaults to `1` if missing or not a positive integer.
- Query: `SELECT twitch_id AS twitchId, username, avatar_url AS avatarUrl FROM
  users ORDER BY username LIMIT 21 OFFSET (page - 1) * 20`.
- If 21 rows come back, trim to the first 20 for the response and set
  `hasMore: true`; otherwise return all rows (≤20) and `hasMore: false`. This
  avoids a separate `COUNT(*)` query to compute total pages.
- Response: `{ users: { twitchId: string; username: string; avatarUrl:
  string | null }[]; page: number; hasMore: boolean }`.
- No `q` filtering — this endpoint always lists everyone, ordered
  alphabetically. The existing `GET /api/admin/users?q=` endpoint is
  untouched and keeps its current top-10-LIKE-match behavior for the search
  box.

Granting a pack from this list reuses the existing `POST
/api/admin/grant-packs` endpoint with `{ twitchId, quantity: 1 }` — no
backend change needed for the grant action itself.

## Frontend

New section in `admin.html`, placed below the existing "Dar blíster"
search block and above "Historial": a heading "Todos los usuarios", a table
with one row per user (username | "+1 blíster" button), and "Anterior" /
"Siguiente" pagination buttons below the table ("Anterior" disabled on page
1, "Siguiente" disabled when `hasMore` is `false`).

In `src/admin.ts`:
- New state: `currentUsersPage: number` (starts at `1`).
- New function `loadUsersList(page: number): Promise<void>` — calls `GET
  /users/all?page=`, renders rows via `document.createElement` (matching the
  existing `textContent`-based rendering pattern from the recent hardening
  fix — no `innerHTML` with DB-sourced strings), updates pagination button
  disabled state, and updates `currentUsersPage`.
- Each row's "+1 blíster" button, on click, opens the same
  `showConfirmModal(quantity, username)` used by the search flow, and on
  confirm calls a shared helper that does `POST /grant-packs { twitchId,
  quantity }`, shows a success/error message, and refreshes both the history
  table and the current page of the users list (in case granting doesn't
  change the list itself, refreshing it is just for consistency with the
  rest of the panel's post-grant refresh behavior).
- Extract the grant-and-refresh logic already used by the search flow's
  `grantPacks()` into a shared function (e.g. `performGrant(twitchId,
  quantity, username)`) so both the search flow and the list's quick button
  call the same code instead of duplicating the fetch + message + refresh
  logic.
- The list loads automatically when the panel view is shown (same timing as
  the existing `loadHistory()` call in `init()` and after `login()`).

## Out of scope

- No search/filter box for the full list (that's what the existing search
  box already does).
- No quantity control on list rows — always exactly 1 pack per click,
  matching the earlier design decision. Larger quantities go through the
  existing search-and-select flow.
- No avatar rendering in the list rows (the existing search flow also fetches
  but never renders `avatarUrl` — this spec doesn't change that).
- No sorting options beyond alphabetical by username.

## Verification

- Manual: open the admin panel, confirm the new "Todos los usuarios" section
  loads with up to 20 users alphabetically; click "Siguiente"/"Anterior" and
  confirm the page changes and button disabled-states are correct at the
  first/last page; click "+1 blíster" on a row, confirm the modal, and
  confirm a new pending pack appears for that user's account and a new row
  appears in the history table.
- `test/routes/admin.test.ts`: add cases for `GET /users/all` — default page
  1 returns up to 20 users ordered alphabetically, `hasMore` is `true` when a
  21st user exists and `false` otherwise, and `page=2` returns the next slice
  correctly.
