# Offers Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users delete finished trade offers (per-user, not shared),
auto-decline pending offers after 7 days, add a visual separator between the
Recibidas/Enviadas columns on `offers.html`, and show a notification dot on
"Ver ofertas de trade" when there's a received offer awaiting action.

**Architecture:** One additive D1 migration (`ALTER TABLE ADD COLUMN`, no
CHECK-constraint changes) adds `auto_expired`, `hidden_from_sender`,
`hidden_from_receiver` to `trade_offers`. `worker/routes/trade.ts` gains a
lazy expiry sweep inside the existing `GET /offers` handler plus two new
routes (`DELETE /offers/:id`, `GET /offers/pending-count`). The frontend
(`src/offers.ts`, `src/user-header.ts`, `src/api.ts`, `src/style.css`) adds
a delete button, a status label override for expired offers, a grid
separator, and a pulsing dot.

**Tech Stack:** Cloudflare Workers + Hono (backend), D1/SQLite, vanilla
TS + Vite (frontend), Vitest with `cloudflare:test` D1 migrations for tests.

## Global Constraints

- No new status enum value — auto-expiry sets `status='declined'` +
  `auto_expired=1`; the `CHECK (status IN (...))` on `trade_offers.status`
  is never touched.
- Soft delete is per-user (`hidden_from_sender`/`hidden_from_receiver`); no
  hard delete, no cleanup job.
- No cron trigger — expiry runs lazily inside `GET /trade/offers`.
- Delete is only allowed when `status !== 'pending'` (409 otherwise).
- Pending-count dot only counts **received** pending offers, not sent.
- Spec: `docs/superpowers/specs/2026-07-03-offers-lifecycle-design.md`.

---

## Task 1: Migration — offer lifecycle columns

**Files:**
- Create: `migrations/0008_trade_offer_lifecycle.sql`

**Interfaces:**
- Produces: `trade_offers.auto_expired INTEGER NOT NULL DEFAULT 0`,
  `trade_offers.hidden_from_sender INTEGER NOT NULL DEFAULT 0`,
  `trade_offers.hidden_from_receiver INTEGER NOT NULL DEFAULT 0`.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE trade_offers ADD COLUMN auto_expired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trade_offers ADD COLUMN hidden_from_sender INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trade_offers ADD COLUMN hidden_from_receiver INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Apply locally and verify the schema**

Run: `npx wrangler d1 execute twitch-cards-db --local --file=migrations/0008_trade_offer_lifecycle.sql`

Then: `npx wrangler d1 execute twitch-cards-db --local --command="PRAGMA table_info(trade_offers)"`

Expected: output lists `auto_expired`, `hidden_from_sender`,
`hidden_from_receiver` columns, all `NOT NULL` with default `0`.

- [ ] **Step 3: Commit**

```bash
git add migrations/0008_trade_offer_lifecycle.sql
git commit -m "feat: add trade offer lifecycle columns"
```

---

## Task 2: Backend — lazy auto-expiry + hidden filtering on `GET /trade/offers`

**Files:**
- Modify: `worker/routes/trade.ts:131-153` (the `trade.get("/offers", ...)` handler)
- Test: `test/routes/trade.test.ts`

**Interfaces:**
- Consumes: `trade_offers.auto_expired`, `hidden_from_sender`,
  `hidden_from_receiver` from Task 1.
- Produces: `GET /api/trade/offers` response items gain `autoExpired:
  boolean` field (camelCase, matching existing `toUser`/`fromUser` naming).
  This is what Task 6 (`src/offers.ts`) reads.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/trade.test.ts` (after the existing "lists offers sent
and received" test):

```ts
it("auto-expires a pending offer older than 7 days on list", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  await env.DB.prepare("UPDATE trade_offers SET created_at = datetime('now', '-8 days') WHERE id = ?")
    .bind(offerId)
    .run();

  const res = await app.request("/api/trade/offers", { headers: { Cookie: cookieTo } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ received: { id: number; status: string; autoExpired: boolean }[] }>();
  expect(json.received).toEqual([expect.objectContaining({ id: offerId, status: "declined", autoExpired: true })]);

  const row = await env.DB.prepare("SELECT status, auto_expired FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string; auto_expired: number }>();
  expect(row).toEqual({ status: "declined", auto_expired: 1 });
});

it("does not expire a pending offer younger than 7 days", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const res = await app.request("/api/trade/offers", { headers: { Cookie: cookieFrom } }, env);
  const json = await res.json<{ sent: { id: number; status: string }[] }>();
  expect(json.sent.find((o) => o.id === offerId)?.status).toBe("pending");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/trade.test.ts -t "auto-expires"`
Expected: FAIL — `autoExpired` is `undefined` (field doesn't exist yet) /
status still `pending`.

- [ ] **Step 3: Implement the expiry sweep + hidden filtering + autoExpired field**

In `worker/routes/trade.ts`, replace the `trade.get("/offers", ...)` handler
(currently lines 131-153) with:

```ts
trade.get("/offers", requireAuth, async (c) => {
  const user = c.get("user");

  await c.env.DB.prepare(
    `UPDATE trade_offers SET status = 'declined', auto_expired = 1
     WHERE status = 'pending' AND created_at <= datetime('now', '-7 days')`
  ).run();

  const sent = await c.env.DB.prepare(
    `SELECT o.id, u.username AS toUser, o.status, o.auto_expired AS autoExpired
     FROM trade_offers o JOIN users u ON u.twitch_id = o.to_user
     WHERE o.from_user = ? AND NOT o.hidden_from_sender ORDER BY o.created_at DESC`
  )
    .bind(user.twitchId)
    .all<{ id: number; toUser: string; status: string; autoExpired: number }>();
  const received = await c.env.DB.prepare(
    `SELECT o.id, u.username AS fromUser, o.status, o.auto_expired AS autoExpired
     FROM trade_offers o JOIN users u ON u.twitch_id = o.from_user
     WHERE o.to_user = ? AND NOT o.hidden_from_receiver ORDER BY o.created_at DESC`
  )
    .bind(user.twitchId)
    .all<{ id: number; fromUser: string; status: string; autoExpired: number }>();

  const allIds = [...sent.results, ...received.results].map((o) => o.id);
  const items = await itemsByOfferId(c.env, allIds);
  const withItems = <T extends { id: number; autoExpired: number }>(offer: T) => ({
    ...offer,
    autoExpired: Boolean(offer.autoExpired),
    items: items.get(offer.id) ?? [],
  });

  return c.json({ sent: sent.results.map(withItems), received: received.results.map(withItems) });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/trade.test.ts`
Expected: PASS, all tests including the two new ones and the pre-existing
"lists offers sent and received" test.

- [ ] **Step 5: Commit**

```bash
git add worker/routes/trade.ts test/routes/trade.test.ts
git commit -m "feat: auto-expire stale pending trade offers"
```

---

## Task 3: Backend — `DELETE /trade/offers/:id`

**Files:**
- Modify: `worker/routes/trade.ts` (add route after the existing
  `trade.post("/offers/:id/cancel", ...)` handler, before `export default trade;`)
- Test: `test/routes/trade.test.ts`

**Interfaces:**
- Consumes: `trade_offers.hidden_from_sender`/`hidden_from_receiver` (Task 1).
- Produces: `DELETE /api/trade/offers/:id` → `200 { ok: true }` on success,
  `404 { error: string }` if not found/not a participant, `409 { error:
  string }` if still pending. Consumed by `deleteOffer()` in Task 5.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/trade.test.ts`:

```ts
it("rejects deleting a pending offer", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const res = await app.request(`/api/trade/offers/${offerId}`, { method: "DELETE", headers: { Cookie: cookieFrom } }, env);
  expect(res.status).toBe(409);
});

it("deletes a finished offer only from the deleting side's view", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();
  await app.request(`/api/trade/offers/${offerId}/decline`, { method: "POST", headers: { Cookie: cookieTo } }, env);

  const deleteRes = await app.request(
    `/api/trade/offers/${offerId}`,
    { method: "DELETE", headers: { Cookie: cookieFrom } },
    env
  );
  expect(deleteRes.status).toBe(200);

  const fromView = await app.request("/api/trade/offers", { headers: { Cookie: cookieFrom } }, env);
  const fromJson = await fromView.json<{ sent: { id: number }[] }>();
  expect(fromJson.sent.find((o) => o.id === offerId)).toBeUndefined();

  const toView = await app.request("/api/trade/offers", { headers: { Cookie: cookieTo } }, env);
  const toJson = await toView.json<{ received: { id: number }[] }>();
  expect(toJson.received.find((o) => o.id === offerId)).toBeDefined();
});

it("rejects deleting an offer the user isn't a participant of", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();
  await app.request(`/api/trade/offers/${offerId}/decline`, { method: "POST", headers: { Cookie: cookieTo } }, env);

  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("3", "viewer3").run();
  const cookieOther = await sessionCookie("3", "viewer3");

  const res = await app.request(`/api/trade/offers/${offerId}`, { method: "DELETE", headers: { Cookie: cookieOther } }, env);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/trade.test.ts -t "delet"`
Expected: FAIL — route doesn't exist, 404 for all requests.

- [ ] **Step 3: Implement the route**

Add to `worker/routes/trade.ts`, right before `export default trade;`:

```ts
trade.delete("/offers/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT from_user, to_user, status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ from_user: string; to_user: string; status: string }>();
  if (!offer || (offer.from_user !== user.twitchId && offer.to_user !== user.twitchId)) {
    return c.json({ error: "Not found" }, 404);
  }
  if (offer.status === "pending") return c.json({ error: "Offer is still pending" }, 409);

  const column = offer.from_user === user.twitchId ? "hidden_from_sender" : "hidden_from_receiver";
  await c.env.DB.prepare(`UPDATE trade_offers SET ${column} = 1 WHERE id = ?`).bind(offerId).run();

  return c.json({ ok: true });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/trade.test.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Commit**

```bash
git add worker/routes/trade.ts test/routes/trade.test.ts
git commit -m "feat: add per-user trade offer delete"
```

---

## Task 4: Backend — `GET /trade/offers/pending-count`

**Files:**
- Modify: `worker/routes/trade.ts` (add route; must be registered before
  `trade.get("/offers", ...)`'s sibling routes don't matter for ordering
  since the path is distinct, but place it next to the other `/offers`
  routes for readability — directly after the `DELETE /offers/:id` route
  added in Task 3)
- Test: `test/routes/trade.test.ts`

**Interfaces:**
- Consumes: `trade_offers.status`, `hidden_from_receiver` (Task 1).
- Produces: `GET /api/trade/offers/pending-count` → `200 { count: number }`.
  Consumed by `getPendingOfferCount()` in Task 5.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/trade.test.ts`:

```ts
it("counts only received pending offers not hidden by the receiver", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");

  const zeroRes = await app.request("/api/trade/offers/pending-count", { headers: { Cookie: cookieTo } }, env);
  expect((await zeroRes.json<{ count: number }>()).count).toBe(0);

  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const oneRes = await app.request("/api/trade/offers/pending-count", { headers: { Cookie: cookieTo } }, env);
  expect((await oneRes.json<{ count: number }>()).count).toBe(1);

  const senderRes = await app.request("/api/trade/offers/pending-count", { headers: { Cookie: cookieFrom } }, env);
  expect((await senderRes.json<{ count: number }>()).count).toBe(0);

  await app.request(`/api/trade/offers/${offerId}/decline`, { method: "POST", headers: { Cookie: cookieTo } }, env);
  const afterDeclineRes = await app.request("/api/trade/offers/pending-count", { headers: { Cookie: cookieTo } }, env);
  expect((await afterDeclineRes.json<{ count: number }>()).count).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/trade.test.ts -t "counts only received"`
Expected: FAIL — 404, route doesn't exist.

- [ ] **Step 3: Implement the route**

Add to `worker/routes/trade.ts`, right after the `trade.delete("/offers/:id", ...)`
route added in Task 3:

```ts
trade.get("/offers/pending-count", requireAuth, async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM trade_offers
     WHERE to_user = ? AND status = 'pending' AND NOT hidden_from_receiver`
  )
    .bind(user.twitchId)
    .first<{ count: number }>();
  return c.json({ count: row?.count ?? 0 });
});
```

Note: Hono matches routes in registration order and `/offers/pending-count`
is a distinct literal path from `/offers/:id`, so no route-shadowing risk —
but keep this route registered before Task 3's `DELETE /offers/:id` is
irrelevant since methods differ (GET vs DELETE) too. No reordering needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/trade.test.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Commit**

```bash
git add worker/routes/trade.ts test/routes/trade.test.ts
git commit -m "feat: add trade offer pending-count endpoint"
```

---

## Task 5: Frontend — `src/api.ts` types and client functions

**Files:**
- Modify: `src/api.ts:69-75` (`TradeOfferSummary` interface), and add two
  new functions after `cancelOffer` (currently ending at line 103).

**Interfaces:**
- Consumes: JSON shapes produced by Tasks 2-4.
- Produces: `TradeOfferSummary.autoExpired: boolean`;
  `deleteOffer(id: number): Promise<{ ok: boolean }>`;
  `getPendingOfferCount(): Promise<{ count: number }>`. Consumed by Task 6
  (`src/offers.ts`) and Task 8 (`src/user-header.ts`).

- [ ] **Step 1: Update `TradeOfferSummary` and add client functions**

In `src/api.ts`, change:

```ts
export interface TradeOfferSummary {
  id: number;
  status: string;
  toUser?: string;
  fromUser?: string;
  items: TradeOfferItem[];
}
```

to:

```ts
export interface TradeOfferSummary {
  id: number;
  status: string;
  autoExpired: boolean;
  toUser?: string;
  fromUser?: string;
  items: TradeOfferItem[];
}
```

Then add after `cancelOffer` (end of file):

```ts
export function deleteOffer(id: number): Promise<{ ok: boolean }> {
  return request(`/trade/offers/${id}`, { method: "DELETE" });
}

export function getPendingOfferCount(): Promise<{ count: number }> {
  return request("/trade/offers/pending-count");
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors (this step alone won't compile-check `offers.ts`
usages yet since they're updated in Task 6, but `api.ts` itself must be
error-free).

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat: add delete/pending-count client functions"
```

---

## Task 6: Frontend — `src/offers.ts` delete button, expired label, separator markup

**Files:**
- Modify: `src/offers.ts` (whole file — small, shown in full below)

**Interfaces:**
- Consumes: `deleteOffer`, `getPendingOfferCount` is NOT used here (that's
  Task 8); `TradeOfferSummary.autoExpired` from Task 5.
- Produces: `#offers-list` now renders three children
  (`.offers-column`, `.offers-separator`, `.offers-column`) instead of two,
  and finished offer cards include a `.delete-offer-btn`. Task 7's CSS
  targets these class names.

- [ ] **Step 1: Rewrite `src/offers.ts`**

```ts
import {
  listOffers,
  acceptOffer,
  declineOffer,
  cancelOffer,
  deleteOffer,
  type TradeOfferItem,
  type TradeOfferSummary,
} from "./api";
import { renderCardHtml } from "./card";
import { initUserHeader } from "./user-header";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  accepted: "Aceptada",
  declined: "Rechazada",
  cancelled: "Cancelada",
};

function statusLabel(offer: TradeOfferSummary): string {
  if (offer.autoExpired) return "Expirada";
  return STATUS_LABELS[offer.status] ?? offer.status;
}

function renderOfferItems(items: TradeOfferItem[], side: "from" | "to"): string {
  const filtered = items.filter((item) => item.side === side);
  if (filtered.length === 0) return `<p class="offer-card-empty">— nada —</p>`;
  return `<div class="offer-card-items">${filtered
    .map((item) => renderCardHtml({ id: item.cardId, name: item.name, rarity: item.rarity, imagePath: item.imagePath, quantity: item.quantity }))
    .join("")}</div>`;
}

function renderOffer(offer: TradeOfferSummary, kind: "sent" | "received"): string {
  const username = kind === "received" ? offer.fromUser : offer.toUser;
  const leftLabel = kind === "received" ? "Te ofrece" : "Tú le pides";
  const rightLabel = kind === "received" ? "Te pide" : "Tú le ofreces";
  const leftSide = kind === "received" ? "from" : "to";
  const rightSide = kind === "received" ? "to" : "from";
  const actions =
    kind === "received" && offer.status === "pending"
      ? `<button class="btn accept-btn" data-id="${offer.id}">Aceptar</button>
         <button class="btn decline-btn" data-id="${offer.id}">Rechazar</button>`
      : kind === "sent" && offer.status === "pending"
        ? `<button class="btn cancel-btn" data-id="${offer.id}">Cancelar</button>`
        : `<button class="btn delete-offer-btn" data-id="${offer.id}">Eliminar</button>`;

  return `<div class="offer-card">
    <div class="offer-card-header">
      <span class="offer-card-user">${username}</span>
      <span class="badge offer-status offer-status-${offer.status}">${statusLabel(offer)}</span>
    </div>
    <div class="offer-card-body">
      <div class="offer-card-side">
        <p class="offer-card-side-label">${leftLabel}</p>
        ${renderOfferItems(offer.items, leftSide)}
      </div>
      <div class="offer-card-side">
        <p class="offer-card-side-label">${rightLabel}</p>
        ${renderOfferItems(offer.items, rightSide)}
      </div>
    </div>
    <div class="offer-card-actions">${actions}</div>
  </div>`;
}

async function loadOffers(): Promise<void> {
  const { sent, received } = await listOffers();
  const container = document.getElementById("offers-list")!;
  container.innerHTML = `
    <div class="offers-column">
      <h2 class="section-heading">Recibidas</h2>
      ${received.length ? received.map((o) => renderOffer(o, "received")).join("") : `<p class="offers-column-empty">— sin ofertas recibidas —</p>`}
    </div>
    <div class="offers-separator"></div>
    <div class="offers-column">
      <h2 class="section-heading">Enviadas</h2>
      ${sent.length ? sent.map((o) => renderOffer(o, "sent")).join("") : `<p class="offers-column-empty">— sin ofertas enviadas —</p>`}
    </div>
  `;

  container.querySelectorAll<HTMLButtonElement>(".accept-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await acceptOffer(Number(btn.dataset.id));
      await loadOffers();
    })
  );
  container.querySelectorAll<HTMLButtonElement>(".decline-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await declineOffer(Number(btn.dataset.id));
      await loadOffers();
    })
  );
  container.querySelectorAll<HTMLButtonElement>(".cancel-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await cancelOffer(Number(btn.dataset.id));
      await loadOffers();
    })
  );
  container.querySelectorAll<HTMLButtonElement>(".delete-offer-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await deleteOffer(Number(btn.dataset.id));
      await loadOffers();
    })
  );
}

initUserHeader();
loadOffers();
```

Note: the previous `${actions ? ... : ""}` wrapper around
`.offer-card-actions` is dropped since `actions` is now always non-empty
(every offer either shows accept/decline, cancel, or delete).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/offers.ts
git commit -m "feat: add offer delete button and expired label"
```

---

## Task 7: Frontend — `src/style.css` separator, delete button, notification dot

**Files:**
- Modify: `src/style.css:644-704` (the `.offers-columns` block and
  surrounding offer-card rules)

**Interfaces:**
- Consumes: `.offers-separator`, `.delete-offer-btn` class names from
  Task 6; `.notif-dot` class name from Task 8.
- Produces: visual styles only, no new interfaces for other tasks.

- [ ] **Step 1: Replace the `.offers-columns` grid rule**

In `src/style.css`, change:

```css
.offers-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  align-items: start;
}
@media (max-width: 700px) {
  .offers-columns { grid-template-columns: 1fr; }
}
```

to:

```css
.offers-columns {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 1.5rem;
  align-items: start;
}
.offers-separator {
  align-self: stretch;
  width: 1px;
  background: var(--border);
}
@media (max-width: 700px) {
  .offers-columns { grid-template-columns: 1fr; }
  .offers-separator { width: 100%; height: 1px; }
}
```

- [ ] **Step 2: Style the delete button to read as a quieter, destructive-ish action**

After the existing `.offer-card-actions` rule (around line 699-704 in the
original file), add:

```css
.delete-offer-btn {
  background: transparent;
  color: var(--muted);
}
.delete-offer-btn:hover {
  color: #E5173A;
  border-color: rgba(229, 23, 58, 0.3);
}
```

- [ ] **Step 3: Add the notification dot and its pulse animation**

At the end of `src/style.css`, add:

```css
.page-header-actions a.btn {
  position: relative;
}
.notif-dot {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--pink);
  animation: notif-pulse 2.2s infinite;
}
@keyframes notif-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

- [ ] **Step 4: Visually verify**

Run: `npm run dev`, open `http://localhost:5173/offers.html` (or whatever
port Vite prints) with a session cookie for a user that has pending and
finished offers. Confirm: vertical line between Recibidas/Enviadas on wide
viewport, horizontal line on a narrow one (resize below 700px), "Eliminar"
button appears on finished offer cards.

- [ ] **Step 5: Commit**

```bash
git add src/style.css
git commit -m "feat: style offers separator, delete button, notif dot"
```

---

## Task 8: Frontend — `src/user-header.ts` notification dot wiring

**Files:**
- Modify: `src/user-header.ts` (whole file — small, shown in full below)

**Interfaces:**
- Consumes: `getPendingOfferCount()` from Task 5; `.notif-dot` CSS class
  from Task 7.
- Produces: nothing consumed elsewhere — this is the final integration point.

- [ ] **Step 1: Rewrite `src/user-header.ts`**

```ts
import { getMe, getPendingOfferCount, logout } from "./api";

export function initUserHeader(): void {
  document.getElementById("logout-btn")!.addEventListener("click", async () => {
    await logout();
    window.location.href = "/";
  });

  getMe().then((me) => {
    document.getElementById("user-name")!.textContent = me.username;
    const avatar = document.getElementById("user-avatar") as HTMLImageElement | null;
    if (avatar) {
      avatar.alt = me.username;
      if (me.avatarUrl) avatar.src = me.avatarUrl;
    }
  });

  const offersLink = document.querySelector<HTMLAnchorElement>('a[href="/offers.html"]');
  if (offersLink) {
    getPendingOfferCount().then(({ count }) => {
      if (count > 0) {
        const dot = document.createElement("span");
        dot.className = "notif-dot";
        offersLink.appendChild(dot);
      }
    });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`. Log in as a user with a pending received offer, open
`collection.html` and `album.html` — confirm the pulsing pink dot appears on
"Ver ofertas de trade". Accept/decline that offer, reload — confirm the dot
disappears. Confirm `offers.html` itself never shows a dot (no matching
anchor on that page).

- [ ] **Step 4: Commit**

```bash
git add src/user-header.ts
git commit -m "feat: show pending-offer notification dot"
```

---

## Task 9: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass, including every test added in Tasks 2-4 and the
full pre-existing `test/routes/trade.test.ts` suite.

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual end-to-end walkthrough**

Using two logged-in accounts (e.g. two browser profiles):
1. Account A sends an offer to Account B.
2. Confirm Account B sees the pulsing dot on "Ver ofertas de trade" on both
   `collection.html` and `album.html`.
3. Account B declines the offer. Dot disappears on reload.
4. On `offers.html`, confirm the declined offer shows an "Eliminar" button
   and the vertical separator is visible between Recibidas/Enviadas.
5. Account B deletes the offer — it disappears from Account B's view but
   still shows (as "Rechazada") in Account A's "Enviadas" column.
6. Create a new pending offer, manually backdate its `created_at` via
   `wrangler d1 execute` (local) to >7 days ago, reload `offers.html` for
   either account — confirm status flips to "Expirada".

- [ ] **Step 4: No commit for this task** (verification only, nothing to stage)

---

## Self-Review Notes

- Spec coverage: delete (Task 3), auto-expiry (Task 2), separator (Tasks 6-7),
  notification dot (Tasks 4, 5, 7, 8) — all five spec requirements have a
  task.
- Type consistency checked: `TradeOfferSummary.autoExpired` (Task 5) matches
  the `autoExpired` field name produced by Task 2's SQL alias
  (`o.auto_expired AS autoExpired`) and consumed in Task 6's `statusLabel()`.
  `deleteOffer(id)` (Task 5) matches the `.delete-offer-btn` handler call in
  Task 6. `getPendingOfferCount()` (Task 5) matches its usage in Task 8.
- No placeholders: every step has complete code, not descriptions.
