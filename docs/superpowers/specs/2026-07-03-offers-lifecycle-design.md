# Offers lifecycle: delete, auto-expire, notification dot

## Problem

`offers.html` lists sent/received trade offers forever — finished offers
(accepted/declined/cancelled) pile up with no way to clear them. Pending
offers never resolve on their own if the other side ignores them. And the
"Ver ofertas de trade" button on `collection.html`/`album.html` gives no hint
that a received offer is waiting for a response.

## Data model

New migration `0008_trade_offer_lifecycle.sql`, three columns added to
`trade_offers` via `ALTER TABLE ... ADD COLUMN` (no CHECK constraint changes,
no table rebuild):

```sql
ALTER TABLE trade_offers ADD COLUMN auto_expired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trade_offers ADD COLUMN hidden_from_sender INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trade_offers ADD COLUMN hidden_from_receiver INTEGER NOT NULL DEFAULT 0;
```

- `auto_expired`: set to `1` when a pending offer is auto-declined after 7
  days. Status stays `'declined'` — no new enum value, so the existing
  `CHECK (status IN (...))` on `trade_offers.status` is untouched.
- `hidden_from_sender` / `hidden_from_receiver`: per-user soft delete. Each
  side can hide a finished offer from their own view without affecting the
  other side's view. No hard delete, no cleanup job — rows stay in the table
  indefinitely (negligible volume for this app).

## Backend (`worker/routes/trade.ts`)

### Auto-expiry (lazy, on read)

At the top of `trade.get("/offers", ...)`, before the existing `sent`/
`received` queries, run:

```sql
UPDATE trade_offers SET status = 'declined', auto_expired = 1
WHERE status = 'pending' AND created_at <= datetime('now', '-7 days')
```

This is a global sweep (not scoped to the requesting user) — whoever loads
`/trade/offers` next pays the tiny cost of expiring any stale rows, and both
sides see the same resolved status afterward. No cron trigger, no scheduled
worker.

### Listing

`sent`/`received` SELECTs each gain a `AND NOT hidden_from_sender` /
`AND NOT hidden_from_receiver` clause (matching which side the querying user
is on). `auto_expired` is selected and passed through into the JSON response
so the frontend can label it distinctly.

### Delete — `DELETE /trade/offers/:id` (new)

- 404 if the offer doesn't exist or the user is neither `from_user` nor
  `to_user`.
- 409 if `status === 'pending'` (only finished offers — accepted, declined,
  cancelled, or auto-expired-declined — can be deleted).
- Otherwise: if `user.twitchId === from_user`, set `hidden_from_sender = 1`;
  if `=== to_user`, set `hidden_from_receiver = 1`. Returns `{ ok: true }`.

### Pending count — `GET /trade/offers/pending-count` (new)

```sql
SELECT COUNT(*) AS count FROM trade_offers
WHERE to_user = ? AND status = 'pending' AND NOT hidden_from_receiver
```

Returns `{ count: number }`. Only counts *received* pending offers — sent
ones don't need the viewer's action, so they don't drive the dot.

## Frontend

### `src/api.ts`

- `TradeOfferSummary` gains `autoExpired: boolean`.
- New `deleteOffer(id: number): Promise<{ ok: boolean }>` → `DELETE
  /trade/offers/${id}`.
- New `getPendingOfferCount(): Promise<{ count: number }>` → `GET
  /trade/offers/pending-count`.

### `src/offers.ts`

- `STATUS_LABELS` lookup replaced by a `statusLabel(offer)` helper: returns
  `"Expirada"` when `offer.autoExpired`, else the existing label map.
  Expired offers keep the `.offer-status-declined` visual style (no new CSS
  class needed).
- `renderOffer`: finished offers (`status !== 'pending'`) get a "Eliminar"
  button (`.btn.delete-offer-btn`) in `.offer-card-actions` alongside/instead
  of the existing accept/decline/cancel buttons (which only ever render for
  pending offers anyway).
- `loadOffers`: wires a `.delete-offer-btn` click handler calling
  `deleteOffer(id)` then `loadOffers()` again, same pattern as the existing
  accept/decline/cancel handlers.
- Container markup changes from two `.offers-column` divs to three children:
  `.offers-column` (Recibidas), `.offers-separator`, `.offers-column`
  (Enviadas).

### `src/user-header.ts`

- After the existing `getMe()` wiring, look for `a[href="/offers.html"]` in
  the page (present on `collection.html`/`album.html`, absent on
  `offers.html` itself — the check is just an element lookup, no per-page
  branching needed).
- If found, call `getPendingOfferCount()`; when `count > 0`, append a
  `<span class="notif-dot"></span>` inside that anchor.

### CSS (`src/style.css`)

- `.offers-columns` becomes a 3-column grid (`1fr auto 1fr`) instead of
  `1fr 1fr`; `.offers-separator` is a 1px-wide full-height bar using
  `var(--border)`. On the existing `@media (max-width: 700px)` stack
  breakpoint, the grid drops to a single column and `.offers-separator`
  becomes a horizontal `1px` bar (`height: 1px; width: 100%`) between the two
  `.offers-column` blocks instead of a vertical line.
- `.notif-dot`: small circle, `position: absolute`, brand `--pink`,
  `@keyframes pulse` (already defined for `.live-dot`) reused for the pulse
  animation. Anchor (`.btn`) hosting it needs `position: relative` if not
  already positioned.

## Testing

- `test/routes/trade.test.ts`: add coverage for
  - `GET /trade/offers` auto-expiring a >7-day-old pending offer (status
    flips to `declined`, `auto_expired = 1`) for both the sender's and
    receiver's view.
  - `DELETE /trade/offers/:id` — 409 on pending, hides for the deleting side
    only (other side still sees it), 404 for a non-participant.
  - `GET /trade/offers/pending-count` — counts only received+pending+
    not-hidden.
- Manual: create an offer between two accounts, accept/decline/cancel it,
  delete it from one account and confirm it still shows for the other;
  confirm the dot appears on `collection.html`/`album.html` when a pending
  received offer exists and disappears once it's actioned.

## Out of scope

- Cron-based expiry (rejected in favor of lazy check-on-read — no cron
  infra exists in this project today).
- Hard-deleting rows or `trade_items` cleanup when both sides have hidden an
  offer.
- A distinct `'expired'` value in the `status` CHECK constraint (would
  require rebuilding `trade_offers`; `auto_expired` flag achieves the same
  UI outcome without touching the existing column).
