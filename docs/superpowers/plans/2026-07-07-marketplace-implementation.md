# Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public marketplace where any user publishes an offer (demand 1 card, offer several) that any other user can accept instantly, replacing the need to negotiate 1:1 trades.

**Architecture:** Two new D1 tables (`marketplace_offers`, `marketplace_offer_items`) plus a `reserved` column added to `user_cards` for escrow. One route file (`worker/routes/marketplace.ts`, mirroring the structure of the existing `worker/routes/trade.ts`) exposing create/list/mine/accept/cancel/delete. One frontend page (`marketplace.html` / `src/marketplace.ts`) with a public-listing tab, a "Mis ofertas" tab, and a 3-step creation wizard built as a dynamically-created modal (same pattern as `openAlbumPickerModal` in `src/collection.ts`).

**Tech Stack:** Hono, D1, vanilla TypeScript, Vitest (`vitest.workers.config.ts` for `worker/**` and `test/**`, `vitest.config.ts` for `src/**`).

**Prerequisite:** The notifications plan (`docs/superpowers/plans/2026-07-07-notifications-implementation.md`) must be implemented first — Task 5 here calls `notify()` from `worker/lib/notifications.ts`.

## Global Constraints

- Demand is always exactly 1 unit of 1 card (no quantity input for the demanded card).
- Max 4 offers per creator counting `active` + `accepted` together (from spec).
- Offers live 7 days: active ones past 7 days are deleted silently (reservation released); accepted ones past 7 days from acceptance are deleted silently (nothing to release). No "expired" status exists.
- Escrow: `user_cards.reserved` tracks cards committed to active marketplace offers. Available = `quantity - reserved`, and this must be respected by `trade.ts` and `collection.ts` too, not just the new marketplace code (decided in brainstorming — otherwise the same card could be promised in a trade and a marketplace offer at once).
- Collection/search screens show only the available amount — no "reserved" breakdown in the UI anywhere.
- Public listing excludes the viewer's own offers, orders newest-first, paginates 6 per page (2×3 grid), and supports two independent optional name filters (`demandQuery`, `offerQuery`).
- Notification on accept: fixed text `"Una oferta tuya ha sido aceptada"`, link `/marketplace.html?tab=mine`.
- Spec: `docs/superpowers/specs/2026-07-07-marketplace-design.md`.

---

### Task 1: Escrow column + cross-cutting availability fix

**Files:**
- Create: `migrations/0021_marketplace.sql`
- Modify: `worker/routes/trade.ts:31-36` (`ownedQuantity`)
- Modify: `worker/routes/collection.ts:11-19` (`GET /`)
- Test: `test/routes/trade.test.ts` (append)
- Test: `test/routes/collection.test.ts` (append)

**Interfaces:**
- Produces: `user_cards.reserved` column (default 0), `marketplace_offers` and `marketplace_offer_items` tables (used by every later task in this plan).

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0021_marketplace.sql
ALTER TABLE user_cards ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0;

CREATE TABLE marketplace_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id TEXT NOT NULL REFERENCES users(twitch_id),
  demand_card_id TEXT NOT NULL REFERENCES cards(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'accepted')),
  acceptor_id TEXT REFERENCES users(twitch_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TEXT
);
CREATE INDEX idx_marketplace_offers_creator ON marketplace_offers(creator_id);
CREATE INDEX idx_marketplace_offers_status ON marketplace_offers(status, created_at DESC);

CREATE TABLE marketplace_offer_items (
  offer_id INTEGER NOT NULL REFERENCES marketplace_offers(id),
  card_id TEXT NOT NULL REFERENCES cards(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
```

- [ ] **Step 2: Write the failing tests**

Append to `test/routes/trade.test.ts` (after the existing `"rejects an offer for more cards than the sender owns"` test):

```ts
it("treats reserved cards as unavailable when validating an offer", async () => {
  await env.DB.prepare("UPDATE user_cards SET reserved = 3 WHERE user_id = ? AND card_id = ?").bind("1", "c1").run();
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  expect(res.status).toBe(409);
});
```

Append to `test/routes/collection.test.ts` (after the `"requires auth"` test):

```ts
it("shows quantity minus reserved as the available amount", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity, reserved) VALUES (?, ?, ?, ?)").bind(
      "1",
      "c1",
      3,
      1
    ),
  ]);
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/collection", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ cards: { id: string; quantity: number }[] }>();
  expect(json.cards.find((c) => c.id === "c1")?.quantity).toBe(2);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/routes/trade.test.ts test/routes/collection.test.ts --config vitest.workers.config.ts`
Expected: FAIL — viewer1 owns 3 of `c1` with 0 reserved (column doesn't exist / defaults to 0), so the trade test gets 201 instead of 409, and the collection test sees `quantity: 3` instead of `2`.

- [ ] **Step 4: Apply the fix**

In `worker/routes/trade.ts`, replace `ownedQuantity`:

```ts
async function ownedQuantity(env: Env, userId: string, cardId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT quantity, reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind(userId, cardId)
    .first<{ quantity: number; reserved: number }>();
  if (!row) return 0;
  return row.quantity - row.reserved;
}
```

In `worker/routes/collection.ts`, change the `SELECT` in `collection.get("/", ...)`:

```ts
  const cards = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.rarity, c.image_path AS imagePath, c.sort_order AS sortOrder, c.generation AS generation,
            COALESCE(uc.quantity, 0) - COALESCE(uc.reserved, 0) AS quantity, uc.updated_at AS acquiredAt
     FROM cards c
     LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = ?
     ORDER BY c.sort_order, c.id`
  )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/routes/trade.test.ts test/routes/collection.test.ts --config vitest.workers.config.ts`
Expected: PASS (all trade.test.ts and collection.test.ts tests, including the 2 new ones)

- [ ] **Step 6: Run the full worker test suite to confirm no regressions**

Run: `npm run test:worker`
Expected: PASS (existing trade/collection tests still pass with `reserved` defaulting to 0)

- [ ] **Step 7: Commit**

```bash
git add migrations/0021_marketplace.sql worker/routes/trade.ts worker/routes/collection.ts test/routes/trade.test.ts test/routes/collection.test.ts
git commit -m "feat: add card reservation escrow shared by trade and marketplace"
```

---

### Task 2: Create marketplace offer

**Files:**
- Create: `worker/routes/marketplace.ts`
- Modify: `worker/index.ts`
- Test: `test/routes/marketplace.test.ts`

**Interfaces:**
- Consumes: `Env`, `SessionUser` from `../types`, `requireAuth` from `../middleware/auth`.
- Produces: `POST /api/marketplace/offers` accepting `{ demandCardId: string; offerItems: { cardId: string; quantity: number }[] }`, returning `{ id: number; status: "active" }` on success. Internal helper `availableQuantity(env, userId, cardId): Promise<number>` — reused by Tasks 3, 4, 5.

- [ ] **Step 1: Write the failing test**

```ts
// test/routes/marketplace.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM marketplace_offer_items");
  await env.DB.exec("DELETE FROM marketplace_offers");
  await env.DB.exec("DELETE FROM user_cards");
  await env.DB.exec("DELETE FROM cards");
  await env.DB.exec("DELETE FROM users");

  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1"),
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "p1",
      "Pikachu",
      "common",
      "/cards/p1.png"
    ),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "c1",
      "Charizard",
      "epic",
      "/cards/c1.png"
    ),
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 3),
  ]);
});

it("creates an active offer and reserves the offered cards", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: number; status: string }>();

  const offer = await env.DB.prepare("SELECT creator_id, demand_card_id, status FROM marketplace_offers WHERE id = ?")
    .bind(id)
    .first<{ creator_id: string; demand_card_id: string; status: string }>();
  expect(offer).toEqual({ creator_id: "1", demand_card_id: "p1", status: "active" });

  const reserved = await env.DB.prepare("SELECT reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ reserved: number }>();
  expect(reserved?.reserved).toBe(2);
});

it("rejects an offer with no offered cards", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [] }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects an offer for more cards than the creator has available", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 99 }] }),
    },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects creating a 5th offer when the creator already has 4 active or accepted", async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'active')"
    ),
    env.DB.prepare(
      "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'active')"
    ),
    env.DB.prepare(
      "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'accepted')"
    ),
    env.DB.prepare(
      "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'accepted')"
    ),
  ]);
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  expect(res.status).toBe(409);
});

it("merges duplicate cardId entries in offerItems before validating", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        demandCardId: "p1",
        offerItems: [
          { cardId: "c1", quantity: 2 },
          { cardId: "c1", quantity: 2 },
        ],
      }),
    },
    env
  );
  expect(res.status).toBe(409); // 4 total > 3 available
});

it("rejects unauthenticated requests", async () => {
  const res = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
    env
  );
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/marketplace.test.ts --config vitest.workers.config.ts`
Expected: FAIL — 404 (route file doesn't exist / not mounted).

- [ ] **Step 3: Write the implementation**

```ts
// worker/routes/marketplace.ts
import { Hono } from "hono";
import type { Env, SessionUser } from "../types";
import { requireAuth } from "../middleware/auth";

const marketplace = new Hono<{ Bindings: Env; Variables: { user: SessionUser } }>();

const MAX_OFFERS_PER_USER = 4;
const OFFER_LIFETIME_DAYS = 7;

interface OfferItemInput {
  cardId: string;
  quantity: number;
}

async function availableQuantity(env: Env, userId: string, cardId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT quantity, reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind(userId, cardId)
    .first<{ quantity: number; reserved: number }>();
  if (!row) return 0;
  return row.quantity - row.reserved;
}

function mergeByCardId(items: OfferItemInput[]): OfferItemInput[] {
  const byCardId = new Map<string, number>();
  for (const item of items) {
    byCardId.set(item.cardId, (byCardId.get(item.cardId) ?? 0) + item.quantity);
  }
  return Array.from(byCardId, ([cardId, quantity]) => ({ cardId, quantity }));
}

marketplace.post("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ demandCardId: string; offerItems: OfferItemInput[] }>();
  const offerItems = mergeByCardId(body.offerItems ?? []);

  if (offerItems.length === 0) return c.json({ error: "Debes ofrecer al menos una carta" }, 400);

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM marketplace_offers WHERE creator_id = ? AND status IN ('active', 'accepted')"
  )
    .bind(user.twitchId)
    .first<{ count: number }>();
  if ((countRow?.count ?? 0) >= MAX_OFFERS_PER_USER) {
    return c.json({ error: "Tienes el máximo de ofertas, elimina alguna antes de crear otra" }, 409);
  }

  for (const item of offerItems) {
    const available = await availableQuantity(c.env, user.twitchId, item.cardId);
    if (available < item.quantity) return c.json({ error: `No tienes suficientes cartas de ${item.cardId}` }, 409);
  }

  const offerResult = await c.env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES (?, ?) RETURNING id"
  )
    .bind(user.twitchId, body.demandCardId)
    .first<{ id: number }>();
  const offerId = offerResult!.id;

  const statements = offerItems.flatMap((item) => [
    c.env.DB.prepare("INSERT INTO marketplace_offer_items (offer_id, card_id, quantity) VALUES (?, ?, ?)").bind(
      offerId,
      item.cardId,
      item.quantity
    ),
    c.env.DB.prepare("UPDATE user_cards SET reserved = reserved + ? WHERE user_id = ? AND card_id = ?").bind(
      item.quantity,
      user.twitchId,
      item.cardId
    ),
  ]);
  await c.env.DB.batch(statements);

  return c.json({ id: offerId, status: "active" }, 201);
});

export default marketplace;
```

```ts
// worker/index.ts — add import and mount (after dailyPack import/mount)
import marketplace from "./routes/marketplace";
// ...
app.route("/api/marketplace", marketplace);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/routes/marketplace.test.ts --config vitest.workers.config.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/routes/marketplace.ts worker/index.ts test/routes/marketplace.test.ts
git commit -m "feat: add marketplace offer creation endpoint"
```

---

### Task 3: "Mis ofertas" listing, cancel, delete

**Files:**
- Modify: `worker/routes/marketplace.ts`
- Modify: `test/routes/marketplace.test.ts`

**Interfaces:**
- Produces: `sweepExpiredOffers(env: Env): Promise<void>` (first used here, reused by Tasks 4 and 5). `itemsByOfferIds(env, offerIds: number[]): Promise<Map<number, { cardId, name, rarity, imagePath, quantity }[]>>` (reused by Task 4). `GET /api/marketplace/offers/mine` → `{ offers: { id, status, createdAt, acceptedAt, demand: {cardId,name,rarity,imagePath}, offerItems: [...] }[] }`. `POST /api/marketplace/offers/:id/cancel` and `DELETE /api/marketplace/offers/:id`.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/marketplace.test.ts`:

```ts
it("lists only the current user's offers, active and accepted", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'active')"),
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('2', 'p1', 'active')"),
  ]);
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers).toHaveLength(1);
});

it("includes offered card details in the mine listing", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{
    offers: { id: number; demand: { name: string }; offerItems: { name: string; quantity: number }[] }[];
  }>();
  const offer = json.offers.find((o) => o.id === id)!;
  expect(offer.demand.name).toBe("Pikachu");
  expect(offer.offerItems).toEqual([expect.objectContaining({ name: "Charizard", quantity: 2 })]);
});

it("cancels an active offer and releases the reservation", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cancelRes = await app.request(`/api/marketplace/offers/${id}/cancel`, { method: "POST", headers: { Cookie: cookie } }, env);
  expect(cancelRes.status).toBe(200);

  const offer = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(id).first();
  expect(offer).toBeNull();
  const reserved = await env.DB.prepare("SELECT reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ reserved: number }>();
  expect(reserved?.reserved).toBe(0);
});

it("rejects cancelling an offer that belongs to someone else", async () => {
  const cookieCreator = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookieCreator, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cookieOther = await sessionCookie("2", "viewer2");
  const res = await app.request(`/api/marketplace/offers/${id}/cancel`, { method: "POST", headers: { Cookie: cookieOther } }, env);
  expect(res.status).toBe(404);
});

it("rejects cancelling an already-accepted offer", async () => {
  await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'accepted')"
  ).run();
  const offer = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE creator_id = '1'").first<{ id: number }>();
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(`/api/marketplace/offers/${offer!.id}/cancel`, { method: "POST", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(409);
});

it("deletes an accepted offer without touching card quantities", async () => {
  await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'accepted')"
  ).run();
  const offer = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE creator_id = '1'").first<{ id: number }>();
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(`/api/marketplace/offers/${offer!.id}`, { method: "DELETE", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(offer!.id).first();
  expect(row).toBeNull();
});

it("rejects deleting an offer that is still active", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();
  const res = await app.request(`/api/marketplace/offers/${id}`, { method: "DELETE", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(409);
});

it("silently expires an active offer older than 7 days and releases its reservation", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();
  await env.DB.prepare("UPDATE marketplace_offers SET created_at = datetime('now', '-8 days') WHERE id = ?")
    .bind(id)
    .run();

  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === id)).toBeUndefined();

  const reserved = await env.DB.prepare("SELECT reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ reserved: number }>();
  expect(reserved?.reserved).toBe(0);
});

it("does not expire an active offer younger than 7 days", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === id)).toBeDefined();
});

it("silently expires an accepted offer older than 7 days without touching card quantities", async () => {
  await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id, status, accepted_at) VALUES ('1', 'p1', 'accepted', datetime('now', '-8 days'))"
  ).run();
  const offer = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE creator_id = '1'").first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === offer!.id)).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/marketplace.test.ts --config vitest.workers.config.ts`
Expected: FAIL — 404s for `/offers/mine`, `/cancel`, and `DELETE`.

- [ ] **Step 3: Write the implementation**

Add to `worker/routes/marketplace.ts`, before `export default marketplace;`:

```ts
async function sweepExpiredOffers(env: Env): Promise<void> {
  const expiredActive = await env.DB.prepare(
    "SELECT id FROM marketplace_offers WHERE status = 'active' AND created_at <= datetime('now', ?)"
  )
    .bind(`-${OFFER_LIFETIME_DAYS} days`)
    .all<{ id: number }>();

  for (const { id } of expiredActive.results) {
    const offer = await env.DB.prepare("SELECT creator_id FROM marketplace_offers WHERE id = ?")
      .bind(id)
      .first<{ creator_id: string }>();
    if (!offer) continue;
    const items = await env.DB.prepare("SELECT card_id, quantity FROM marketplace_offer_items WHERE offer_id = ?")
      .bind(id)
      .all<{ card_id: string; quantity: number }>();

    const statements = items.results.map((item) =>
      env.DB.prepare("UPDATE user_cards SET reserved = reserved - ? WHERE user_id = ? AND card_id = ?").bind(
        item.quantity,
        offer.creator_id,
        item.card_id
      )
    );
    statements.push(env.DB.prepare("DELETE FROM marketplace_offer_items WHERE offer_id = ?").bind(id));
    statements.push(env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ?").bind(id));
    await env.DB.batch(statements);
  }

  const expiredAccepted = await env.DB.prepare(
    "SELECT id FROM marketplace_offers WHERE status = 'accepted' AND accepted_at <= datetime('now', ?)"
  )
    .bind(`-${OFFER_LIFETIME_DAYS} days`)
    .all<{ id: number }>();
  for (const { id } of expiredAccepted.results) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM marketplace_offer_items WHERE offer_id = ?").bind(id),
      env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ?").bind(id),
    ]);
  }
}

interface MarketplaceItemRow {
  offer_id: number;
  cardId: string;
  name: string;
  rarity: string;
  imagePath: string;
  quantity: number;
}

async function itemsByOfferIds(
  env: Env,
  offerIds: number[]
): Promise<Map<number, { cardId: string; name: string; rarity: string; imagePath: string; quantity: number }[]>> {
  const byOfferId = new Map<
    number,
    { cardId: string; name: string; rarity: string; imagePath: string; quantity: number }[]
  >();
  if (offerIds.length === 0) return byOfferId;

  const placeholders = offerIds.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT oi.offer_id, c.id AS cardId, c.name, c.rarity, c.image_path AS imagePath, oi.quantity
     FROM marketplace_offer_items oi JOIN cards c ON c.id = oi.card_id
     WHERE oi.offer_id IN (${placeholders})`
  )
    .bind(...offerIds)
    .all<MarketplaceItemRow>();

  for (const row of rows.results) {
    const list = byOfferId.get(row.offer_id) ?? [];
    list.push({ cardId: row.cardId, name: row.name, rarity: row.rarity, imagePath: row.imagePath, quantity: row.quantity });
    byOfferId.set(row.offer_id, list);
  }
  return byOfferId;
}

interface MineOfferRow {
  id: number;
  demandCardId: string;
  status: string;
  createdAt: string;
  acceptedAt: string | null;
  demandName: string;
  demandRarity: string;
  demandImagePath: string;
}

marketplace.get("/offers/mine", requireAuth, async (c) => {
  const user = c.get("user");
  await sweepExpiredOffers(c.env);

  const offers = await c.env.DB.prepare(
    `SELECT o.id, o.demand_card_id AS demandCardId, o.status, o.created_at AS createdAt, o.accepted_at AS acceptedAt,
            dc.name AS demandName, dc.rarity AS demandRarity, dc.image_path AS demandImagePath
     FROM marketplace_offers o JOIN cards dc ON dc.id = o.demand_card_id
     WHERE o.creator_id = ? ORDER BY o.created_at DESC`
  )
    .bind(user.twitchId)
    .all<MineOfferRow>();

  const items = await itemsByOfferIds(c.env, offers.results.map((o) => o.id));

  return c.json({
    offers: offers.results.map((o) => ({
      id: o.id,
      status: o.status,
      createdAt: o.createdAt,
      acceptedAt: o.acceptedAt,
      demand: { cardId: o.demandCardId, name: o.demandName, rarity: o.demandRarity, imagePath: o.demandImagePath },
      offerItems: items.get(o.id) ?? [],
    })),
  });
});

marketplace.post("/offers/:id/cancel", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT creator_id, status FROM marketplace_offers WHERE id = ?")
    .bind(offerId)
    .first<{ creator_id: string; status: string }>();
  if (!offer || offer.creator_id !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (offer.status !== "active") return c.json({ error: "La oferta no está activa" }, 409);

  const items = await c.env.DB.prepare("SELECT card_id, quantity FROM marketplace_offer_items WHERE offer_id = ?")
    .bind(offerId)
    .all<{ card_id: string; quantity: number }>();

  const statements = items.results.map((item) =>
    c.env.DB.prepare("UPDATE user_cards SET reserved = reserved - ? WHERE user_id = ? AND card_id = ?").bind(
      item.quantity,
      user.twitchId,
      item.card_id
    )
  );
  statements.push(c.env.DB.prepare("DELETE FROM marketplace_offer_items WHERE offer_id = ?").bind(offerId));
  statements.push(c.env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ?").bind(offerId));
  await c.env.DB.batch(statements);

  return c.json({ ok: true });
});

marketplace.delete("/offers/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT creator_id, status FROM marketplace_offers WHERE id = ?")
    .bind(offerId)
    .first<{ creator_id: string; status: string }>();
  if (!offer || offer.creator_id !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (offer.status !== "accepted") return c.json({ error: "Solo se pueden eliminar ofertas aceptadas" }, 409);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM marketplace_offer_items WHERE offer_id = ?").bind(offerId),
    c.env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ?").bind(offerId),
  ]);

  return c.json({ ok: true });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/marketplace.test.ts --config vitest.workers.config.ts`
Expected: PASS (16 tests total)

- [ ] **Step 5: Commit**

```bash
git add worker/routes/marketplace.ts test/routes/marketplace.test.ts
git commit -m "feat: add mine listing, cancel, delete, and 7-day expiry sweep"
```

---

### Task 4: Public listing with filters, pagination, and "Tienes X"

**Files:**
- Modify: `worker/routes/marketplace.ts`
- Modify: `test/routes/marketplace.test.ts`

**Interfaces:**
- Produces: `GET /api/marketplace/offers?page=&demandQuery=&offerQuery=` → `{ offers: { id, creatorUsername, createdAt, demand: {cardId,name,rarity,imagePath,viewerQuantity}, offerItems: [{cardId,name,rarity,imagePath,quantity,viewerQuantity}] }[], totalCount, page, pageSize }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/marketplace.test.ts`:

```ts
it("excludes the viewer's own offers from the public listing", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  const res = await app.request("/api/marketplace/offers", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: unknown[] }>();
  expect(json.offers).toHaveLength(0);
});

it("shows another user's active offer with the viewer's owned quantity", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES ('2', 'c1', 5)").run();
  const cookieCreator = await sessionCookie("2", "viewer2");
  await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookieCreator, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );

  const cookieViewer = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers", { headers: { Cookie: cookieViewer } }, env);
  const json = await res.json<{
    offers: {
      creatorUsername: string;
      demand: { viewerQuantity: number };
      offerItems: { cardId: string; viewerQuantity: number }[];
    }[];
  }>();
  expect(json.offers).toHaveLength(1);
  expect(json.offers[0].creatorUsername).toBe("viewer2");
  expect(json.offers[0].demand.viewerQuantity).toBe(0); // viewer1 has 0 of p1
  expect(json.offers[0].offerItems[0].viewerQuantity).toBe(3); // viewer1 owns 3 of c1
});

it("filters the public listing by demand card name", async () => {
  const cookieCreator = await sessionCookie("2", "viewer2");
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES ('2', 'c1', 5)").run();
  await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookieCreator, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );

  const cookieViewer = await sessionCookie("1", "viewer1");
  const matchRes = await app.request(
    "/api/marketplace/offers?demandQuery=pika",
    { headers: { Cookie: cookieViewer } },
    env
  );
  expect((await matchRes.json<{ offers: unknown[] }>()).offers).toHaveLength(1);

  const noMatchRes = await app.request(
    "/api/marketplace/offers?demandQuery=zzz",
    { headers: { Cookie: cookieViewer } },
    env
  );
  expect((await noMatchRes.json<{ offers: unknown[] }>()).offers).toHaveLength(0);
});

it("filters the public listing by offered card name", async () => {
  const cookieCreator = await sessionCookie("2", "viewer2");
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES ('2', 'c1', 5)").run();
  await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookieCreator, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );

  const cookieViewer = await sessionCookie("1", "viewer1");
  const matchRes = await app.request(
    "/api/marketplace/offers?offerQuery=char",
    { headers: { Cookie: cookieViewer } },
    env
  );
  expect((await matchRes.json<{ offers: unknown[] }>()).offers).toHaveLength(1);

  const noMatchRes = await app.request(
    "/api/marketplace/offers?offerQuery=zzz",
    { headers: { Cookie: cookieViewer } },
    env
  );
  expect((await noMatchRes.json<{ offers: unknown[] }>()).offers).toHaveLength(0);
});

it("paginates the public listing 6 per page, newest first", async () => {
  const userStatements = [];
  for (let i = 0; i < 8; i++) {
    userStatements.push(
      env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind(`page-user-${i}`, `pageuser${i}`)
    );
  }
  await env.DB.batch(userStatements);

  // Direct inserts (bypassing the create route) sidestep the 4-offers-per-creator cap and let each
  // offer get a distinct creator, which is what a real paginated marketplace would look like anyway.
  const offerStatements = [];
  for (let i = 0; i < 8; i++) {
    offerStatements.push(
      env.DB.prepare(
        "INSERT INTO marketplace_offers (creator_id, demand_card_id, status, created_at) VALUES (?, 'p1', 'active', datetime('now', ?))"
      ).bind(`page-user-${i}`, `-${i} minutes`)
    );
  }
  await env.DB.batch(offerStatements);

  const cookieViewer = await sessionCookie("1", "viewer1");
  const page1Res = await app.request("/api/marketplace/offers?page=1", { headers: { Cookie: cookieViewer } }, env);
  const page1 = await page1Res.json<{
    offers: { creatorUsername: string }[];
    totalCount: number;
    page: number;
    pageSize: number;
  }>();
  expect(page1.pageSize).toBe(6);
  expect(page1.totalCount).toBe(8);
  expect(page1.offers).toHaveLength(6);
  // "-0 minutes" (pageuser0) is newest, so it must lead page 1.
  expect(page1.offers[0].creatorUsername).toBe("pageuser0");

  const page2Res = await app.request("/api/marketplace/offers?page=2", { headers: { Cookie: cookieViewer } }, env);
  const page2 = await page2Res.json<{ offers: { creatorUsername: string }[] }>();
  expect(page2.offers).toHaveLength(2);
  expect(page2.offers[1].creatorUsername).toBe("pageuser7");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/marketplace.test.ts --config vitest.workers.config.ts`
Expected: FAIL — 404 for `GET /api/marketplace/offers` (route not yet defined; `/offers/mine` is a distinct path already handled by Task 3 and won't conflict).

- [ ] **Step 3: Write the implementation**

Add to `worker/routes/marketplace.ts`, before `export default marketplace;`:

```ts
const PAGE_SIZE = 6;

async function viewerQuantitiesByCardIds(env: Env, userId: string, cardIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (cardIds.length === 0) return result;
  const placeholders = cardIds.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT card_id, quantity - reserved AS available FROM user_cards WHERE user_id = ? AND card_id IN (${placeholders})`
  )
    .bind(userId, ...cardIds)
    .all<{ card_id: string; available: number }>();
  for (const row of rows.results) result.set(row.card_id, row.available);
  return result;
}

interface PublicOfferRow {
  id: number;
  creatorUsername: string;
  demandCardId: string;
  createdAt: string;
  demandName: string;
  demandRarity: string;
  demandImagePath: string;
  demandViewerQty: number;
}

marketplace.get("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  await sweepExpiredOffers(c.env);

  const page = Math.max(1, Number(c.req.query("page") ?? "1"));
  const demandQuery = c.req.query("demandQuery") ?? "";
  const offerQuery = c.req.query("offerQuery") ?? "";
  const offset = (page - 1) * PAGE_SIZE;

  const whereClause = `
    o.status = 'active' AND o.creator_id != ?
    AND (? = '' OR dc.name LIKE '%' || ? || '%')
    AND (? = '' OR EXISTS (
      SELECT 1 FROM marketplace_offer_items oi2 JOIN cards oc2 ON oc2.id = oi2.card_id
      WHERE oi2.offer_id = o.id AND oc2.name LIKE '%' || ? || '%'
    ))
  `;
  const filterParams = [user.twitchId, demandQuery, demandQuery, offerQuery, offerQuery];

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM marketplace_offers o JOIN cards dc ON dc.id = o.demand_card_id WHERE ${whereClause}`
  )
    .bind(...filterParams)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT o.id, u.username AS creatorUsername, o.demand_card_id AS demandCardId, o.created_at AS createdAt,
            dc.name AS demandName, dc.rarity AS demandRarity, dc.image_path AS demandImagePath,
            COALESCE(v.quantity, 0) - COALESCE(v.reserved, 0) AS demandViewerQty
     FROM marketplace_offers o
     JOIN users u ON u.twitch_id = o.creator_id
     JOIN cards dc ON dc.id = o.demand_card_id
     LEFT JOIN user_cards v ON v.card_id = o.demand_card_id AND v.user_id = ?
     WHERE ${whereClause}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ? OFFSET ?`
  )
    .bind(user.twitchId, ...filterParams, PAGE_SIZE, offset)
    .all<PublicOfferRow>();

  const offerIds = rows.results.map((r) => r.id);
  const items = await itemsByOfferIds(c.env, offerIds);
  const allItemCardIds = Array.from(new Set(Array.from(items.values()).flat().map((i) => i.cardId)));
  const viewerQuantities = await viewerQuantitiesByCardIds(c.env, user.twitchId, allItemCardIds);

  return c.json({
    offers: rows.results.map((r) => ({
      id: r.id,
      creatorUsername: r.creatorUsername,
      createdAt: r.createdAt,
      demand: {
        cardId: r.demandCardId,
        name: r.demandName,
        rarity: r.demandRarity,
        imagePath: r.demandImagePath,
        viewerQuantity: r.demandViewerQty,
      },
      offerItems: (items.get(r.id) ?? []).map((i) => ({ ...i, viewerQuantity: viewerQuantities.get(i.cardId) ?? 0 })),
    })),
    totalCount: countRow?.count ?? 0,
    page,
    pageSize: PAGE_SIZE,
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/marketplace.test.ts --config vitest.workers.config.ts`
Expected: PASS (21 tests total)

- [ ] **Step 5: Commit**

```bash
git add worker/routes/marketplace.ts test/routes/marketplace.test.ts
git commit -m "feat: add public marketplace listing with filters and pagination"
```

---

### Task 5: Accept offer

**Files:**
- Modify: `worker/routes/marketplace.ts`
- Modify: `test/routes/marketplace.test.ts`

**Interfaces:**
- Consumes: `notify(env, userId, message, link?)` from `worker/lib/notifications.ts` (notifications plan, Task 1).
- Produces: `POST /api/marketplace/offers/:id/accept` → `{ status: "accepted" }` or error.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/marketplace.test.ts`:

```ts
it("accepts an offer, swaps cards, and notifies the creator", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES ('2', 'p1', 1)").run();
  const cookieCreator = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookieCreator, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cookieAcceptor = await sessionCookie("2", "viewer2");
  const acceptRes = await app.request(`/api/marketplace/offers/${id}/accept`, { method: "POST", headers: { Cookie: cookieAcceptor } }, env);
  expect(acceptRes.status).toBe(200);

  const offer = await env.DB.prepare("SELECT status, acceptor_id FROM marketplace_offers WHERE id = ?")
    .bind(id)
    .first<{ status: string; acceptor_id: string }>();
  expect(offer).toEqual({ status: "accepted", acceptor_id: "2" });

  const creatorC1 = await env.DB.prepare("SELECT quantity, reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number; reserved: number }>();
  expect(creatorC1).toEqual({ quantity: 1, reserved: 0 });

  const acceptorC1 = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("2", "c1")
    .first<{ quantity: number }>();
  expect(acceptorC1?.quantity).toBe(2);

  const creatorP1 = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "p1")
    .first<{ quantity: number }>();
  expect(creatorP1?.quantity).toBe(1);

  const acceptorP1 = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("2", "p1")
    .first<{ quantity: number }>();
  expect(acceptorP1?.quantity).toBe(0);

  const notification = await env.DB.prepare("SELECT message, link FROM notifications WHERE user_id = ?")
    .bind("1")
    .first<{ message: string; link: string }>();
  expect(notification).toEqual({ message: "Una oferta tuya ha sido aceptada", link: "/marketplace.html?tab=mine" });
});

it("rejects accepting an offer with no demanded card in hand", async () => {
  const cookieCreator = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookieCreator, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cookieAcceptor = await sessionCookie("2", "viewer2");
  const res = await app.request(`/api/marketplace/offers/${id}/accept`, { method: "POST", headers: { Cookie: cookieAcceptor } }, env);
  expect(res.status).toBe(409);

  const offer = await env.DB.prepare("SELECT status, acceptor_id FROM marketplace_offers WHERE id = ?")
    .bind(id)
    .first<{ status: string; acceptor_id: string | null }>();
  expect(offer).toEqual({ status: "active", acceptor_id: null });
});

it("rejects a creator accepting their own offer", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();
  const res = await app.request(`/api/marketplace/offers/${id}/accept`, { method: "POST", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(400);
});

it("rejects a second accept attempt once the offer is already accepted", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES ('2', 'p1', 5)").run();
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES ('3', 'viewer3')").run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES ('3', 'p1', 5)").run();

  const cookieCreator = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookieCreator, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cookieAcceptor2 = await sessionCookie("2", "viewer2");
  const firstAccept = await app.request(`/api/marketplace/offers/${id}/accept`, { method: "POST", headers: { Cookie: cookieAcceptor2 } }, env);
  expect(firstAccept.status).toBe(200);

  const cookieAcceptor3 = await sessionCookie("3", "viewer3");
  const secondAccept = await app.request(`/api/marketplace/offers/${id}/accept`, { method: "POST", headers: { Cookie: cookieAcceptor3 } }, env);
  expect(secondAccept.status).toBe(409);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/marketplace.test.ts --config vitest.workers.config.ts`
Expected: FAIL — 404 for `POST /offers/:id/accept`.

- [ ] **Step 3: Write the implementation**

Add to `worker/routes/marketplace.ts`:

```ts
// top of file, alongside the other imports
import { notify } from "../lib/notifications";
```

```ts
// before export default marketplace;
marketplace.post("/offers/:id/accept", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  await sweepExpiredOffers(c.env);

  const offer = await c.env.DB.prepare(
    "SELECT creator_id, demand_card_id AS demandCardId, status FROM marketplace_offers WHERE id = ?"
  )
    .bind(offerId)
    .first<{ creator_id: string; demandCardId: string; status: string }>();
  if (!offer) return c.json({ error: "Not found" }, 404);
  if (offer.creator_id === user.twitchId) return c.json({ error: "No puedes aceptar tu propia oferta" }, 400);

  const guardResult = await c.env.DB.prepare(
    "UPDATE marketplace_offers SET status = 'accepted', acceptor_id = ?, accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'"
  )
    .bind(user.twitchId, offerId)
    .run();
  if (guardResult.meta.changes === 0) return c.json({ error: "Oferta ya no disponible" }, 409);

  const acceptorAvailable = await availableQuantity(c.env, user.twitchId, offer.demandCardId);
  if (acceptorAvailable < 1) {
    await c.env.DB.prepare(
      "UPDATE marketplace_offers SET status = 'active', acceptor_id = NULL, accepted_at = NULL WHERE id = ?"
    )
      .bind(offerId)
      .run();
    return c.json({ error: "No tienes el cromo demandado" }, 409);
  }

  const items = await c.env.DB.prepare("SELECT card_id, quantity FROM marketplace_offer_items WHERE offer_id = ?")
    .bind(offerId)
    .all<{ card_id: string; quantity: number }>();

  const statements = items.results.flatMap((item) => [
    c.env.DB.prepare(
      "UPDATE user_cards SET quantity = quantity - ?, reserved = reserved - ? WHERE user_id = ? AND card_id = ?"
    ).bind(item.quantity, item.quantity, offer.creator_id, item.card_id),
    c.env.DB.prepare(
      `INSERT INTO user_cards (user_id, card_id, quantity, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP`
    ).bind(user.twitchId, item.card_id, item.quantity, item.quantity),
  ]);
  statements.push(
    c.env.DB.prepare("UPDATE user_cards SET quantity = quantity - 1 WHERE user_id = ? AND card_id = ?").bind(
      user.twitchId,
      offer.demandCardId
    )
  );
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO user_cards (user_id, card_id, quantity, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP`
    ).bind(offer.creator_id, offer.demandCardId)
  );
  await c.env.DB.batch(statements);

  await notify(c.env, offer.creator_id, "Una oferta tuya ha sido aceptada", "/marketplace.html?tab=mine");

  return c.json({ status: "accepted" });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/marketplace.test.ts --config vitest.workers.config.ts`
Expected: PASS (25 tests total)

- [ ] **Step 5: Run the full worker suite**

Run: `npm run test:worker`
Expected: PASS (no regressions in trade/collection/notifications)

- [ ] **Step 6: Commit**

```bash
git add worker/routes/marketplace.ts test/routes/marketplace.test.ts
git commit -m "feat: add marketplace offer acceptance with atomic double-accept guard"
```

---

### Task 6: Frontend API client

**Files:**
- Modify: `src/api.ts`

**Interfaces:**
- Produces: `MarketplaceCardView`, `MarketplaceOfferSummary`, `MyMarketplaceOffer` types, `listMarketplaceOffers`, `listMyMarketplaceOffers`, `createMarketplaceOffer`, `acceptMarketplaceOffer`, `cancelMarketplaceOffer`, `deleteMarketplaceOffer`. Task 8 and 9 import these.

- [ ] **Step 1: Append to `src/api.ts`**

```ts
export interface MarketplaceCardView {
  cardId: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
  quantity: number;
  viewerQuantity: number;
}

export interface MarketplaceOfferSummary {
  id: number;
  creatorUsername: string;
  createdAt: string;
  demand: { cardId: string; name: string; rarity: Rarity; imagePath: string; viewerQuantity: number };
  offerItems: MarketplaceCardView[];
}

export interface MyMarketplaceOffer {
  id: number;
  status: "active" | "accepted";
  createdAt: string;
  acceptedAt: string | null;
  demand: { cardId: string; name: string; rarity: Rarity; imagePath: string };
  offerItems: { cardId: string; name: string; rarity: Rarity; imagePath: string; quantity: number }[];
}

export function listMarketplaceOffers(params: {
  page: number;
  demandQuery?: string;
  offerQuery?: string;
}): Promise<{ offers: MarketplaceOfferSummary[]; totalCount: number; page: number; pageSize: number }> {
  const q = new URLSearchParams({ page: String(params.page) });
  if (params.demandQuery) q.set("demandQuery", params.demandQuery);
  if (params.offerQuery) q.set("offerQuery", params.offerQuery);
  return request(`/marketplace/offers?${q.toString()}`);
}

export function listMyMarketplaceOffers(): Promise<{ offers: MyMarketplaceOffer[] }> {
  return request("/marketplace/offers/mine");
}

export function createMarketplaceOffer(input: {
  demandCardId: string;
  offerItems: { cardId: string; quantity: number }[];
}): Promise<{ id: number; status: string }> {
  return request("/marketplace/offers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function acceptMarketplaceOffer(id: number): Promise<{ status: string }> {
  return request(`/marketplace/offers/${id}/accept`, { method: "POST" });
}

export function cancelMarketplaceOffer(id: number): Promise<{ ok: boolean }> {
  return request(`/marketplace/offers/${id}/cancel`, { method: "POST" });
}

export function deleteMarketplaceOffer(id: number): Promise<{ ok: boolean }> {
  return request(`/marketplace/offers/${id}`, { method: "DELETE" });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat: add marketplace API client functions"
```

---

### Task 7: Marketplace page shell + navigation

**Files:**
- Create: `marketplace.html`
- Modify: `vite.config.ts`
- Modify: `collection.html`, `trade.html`, `album.html`, `offers.html` (add nav link)
- Test: `src/marketplace-nav.test.ts`

**Interfaces:**
- Produces: static DOM ids `mp-tab-public`, `mp-tab-mine`, `mp-public-view`, `mp-mine-view`, `mp-demand-filter`, `mp-offer-filter`, `mp-public-grid`, `mp-prev-page`, `mp-next-page`, `mp-page-label`, `mp-create-btn`, `mp-mine-grid` — Task 8/9 wire behavior onto these.

- [ ] **Step 1: Write the failing test**

```ts
// src/marketplace-nav.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("marketplace nav link", () => {
  it.each(["collection.html", "trade.html", "album.html", "offers.html"])("is present in %s", (file) => {
    const html = readFileSync(resolve(__dirname, "..", file), "utf-8");
    expect(html).toContain('href="/marketplace.html"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/marketplace-nav.test.ts`
Expected: FAIL — none of the 4 files contain the link yet.

- [ ] **Step 3: Create `marketplace.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Russo+One&family=Quicksand:wght@500;700&family=JetBrains+Mono:wght@600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/src/style.css" />
    <title>Marketplace</title>
  </head>
  <body>
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
        <a
          class="donate-btn"
          href="https://www.paypal.com/paypalme/MrKlypp"
          target="_blank"
          rel="noopener"
          title="Incluye tu usuario de Twitch en la nota del pago para recibir tu sobre automáticamente"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 21s-6.5-4.35-9.3-8.28C.86 10.36 1.2 7 4 5.5c2.1-1.13 4.5-.5 5.7 1.2L12 9.3l2.3-2.6c1.2-1.7 3.6-2.33 5.7-1.2 2.8 1.5 3.14 4.86 1.3 7.22C18.5 16.65 12 21 12 21z" />
          </svg>
          Donar
        </a>
        <img id="user-avatar" class="user-avatar" alt="" />
        <span id="user-name" class="user-name"></span>
        <button class="icon-btn" id="logout-btn" type="button" title="Cerrar sesión" aria-label="Cerrar sesión">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>
    </header>
    <div class="container" style="padding: 2rem 1rem;">
      <h1>Marketplace</h1>

      <div class="mp-tabs">
        <button class="btn" id="mp-tab-public" type="button">Marketplace</button>
        <button class="btn" id="mp-tab-mine" type="button">Mis ofertas</button>
      </div>

      <div id="mp-public-view">
        <div class="mp-filters">
          <input class="input" id="mp-demand-filter" placeholder="Filtrar por demanda..." />
          <input class="input" id="mp-offer-filter" placeholder="Filtrar por oferta..." />
        </div>
        <div id="mp-public-grid" class="mp-grid mp-grid-offers"></div>
        <div class="mp-pagination">
          <button class="btn" id="mp-prev-page" type="button">Anterior</button>
          <span id="mp-page-label"></span>
          <button class="btn" id="mp-next-page" type="button">Siguiente</button>
        </div>
      </div>

      <div id="mp-mine-view" hidden>
        <button class="btn" id="mp-create-btn" type="button">Crear oferta</button>
        <div id="mp-mine-grid" class="mp-grid mp-grid-offers mp-grid-mine"></div>
      </div>
    </div>
    <footer class="site-footer">
      Creado por <a href="https://mrklypp.com/" target="_blank" rel="noopener">MrKlypp</a> · © 2026
    </footer>
    <script type="module" src="/src/marketplace.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: Add the vite build entry**

In `vite.config.ts`, add to `rollupOptions.input` (after `offers`):

```ts
            marketplace: path.resolve(__dirname, "marketplace.html"),
```

- [ ] **Step 5: Add the nav link to the other 4 pages**

In `collection.html`, `trade.html`, `album.html`, `offers.html`, inside `.page-header-actions`, add (matching the existing `<a class="btn" ...>` style used for e.g. "Ver ofertas de trade"):

```html
        <a class="btn" href="/marketplace.html">Marketplace</a>
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/marketplace-nav.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add marketplace.html vite.config.ts collection.html trade.html album.html offers.html src/marketplace-nav.test.ts
git commit -m "feat: add marketplace page shell and navigation links"
```

---

### Task 8: Public + Mine view rendering, tabs, pagination, filters, cancel/delete, accept modal

**Files:**
- Create: `src/marketplace.ts`
- Test: `src/marketplace.test.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `listMarketplaceOffers`, `listMyMarketplaceOffers`, `cancelMarketplaceOffer`, `deleteMarketplaceOffer`, `acceptMarketplaceOffer`, `MarketplaceOfferSummary`, `MyMarketplaceOffer` from Task 6. `renderCardHtml` from `./card`. `initUserHeader` from `./user-header`.
- Produces (exported, tested directly): `formatDate(iso: string): string`, `renderMarketplaceCard(item, badgeHtml: string): string`, `renderPublicOfferCard(offer: MarketplaceOfferSummary): string`, `renderMyOfferCard(offer: MyMarketplaceOffer): string`. Task 9 adds the creation wizard to this same file and reuses `renderMarketplaceCard`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/marketplace.test.ts
import { describe, it, expect } from "vitest";
import { formatDate, renderPublicOfferCard, renderMyOfferCard } from "./marketplace";

describe("formatDate", () => {
  it("formats a SQLite timestamp as dd/mm/aaaa", () => {
    expect(formatDate("2026-07-07 10:30:00")).toBe("07/07/2026");
  });
});

describe("renderPublicOfferCard", () => {
  const offer = {
    id: 1,
    creatorUsername: "otheruser",
    createdAt: "2026-07-01 00:00:00",
    demand: { cardId: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png", viewerQuantity: 0 },
    offerItems: [
      { cardId: "p2", name: "Charizard", rarity: "epic" as const, imagePath: "/p2.png", quantity: 2, viewerQuantity: 1 },
    ],
  };

  it("shows the creator username and formatted date", () => {
    const html = renderPublicOfferCard(offer);
    expect(html).toContain("Oferta de otheruser");
    expect(html).toContain("01/07/2026");
  });

  it("disables the accept button when the viewer doesn't have the demanded card", () => {
    const html = renderPublicOfferCard(offer);
    const btnMatch = html.match(/<button[^>]*class="btn mp-accept-btn"[^>]*>/)![0];
    expect(btnMatch).toContain("disabled");
  });

  it("enables the accept button when the viewer has the demanded card", () => {
    const html = renderPublicOfferCard({ ...offer, demand: { ...offer.demand, viewerQuantity: 1 } });
    const btnMatch = html.match(/<button[^>]*class="btn mp-accept-btn"[^>]*>/)![0];
    expect(btnMatch).not.toContain("disabled");
  });

  it("shows how many the viewer has of each offered card", () => {
    const html = renderPublicOfferCard(offer);
    expect(html).toContain("Tienes 1");
  });
});

describe("renderMyOfferCard", () => {
  const activeOffer = {
    id: 5,
    status: "active" as const,
    createdAt: "2026-07-01 00:00:00",
    acceptedAt: null,
    demand: { cardId: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png" },
    offerItems: [{ cardId: "p2", name: "Charizard", rarity: "epic" as const, imagePath: "/p2.png", quantity: 3 }],
  };

  it("shows a Cancelar button for an active offer", () => {
    const html = renderMyOfferCard(activeOffer);
    expect(html).toContain("mp-cancel-btn");
    expect(html).not.toContain("mp-delete-btn");
  });

  it("shows an Eliminar button for an accepted offer", () => {
    const html = renderMyOfferCard({ ...activeOffer, status: "accepted", acceptedAt: "2026-07-02 00:00:00" });
    expect(html).toContain("mp-delete-btn");
    expect(html).not.toContain("mp-cancel-btn");
  });

  it("shows the offered quantity as a badge", () => {
    const html = renderMyOfferCard(activeOffer);
    expect(html).toContain("x3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/marketplace.test.ts`
Expected: FAIL — `Cannot find module './marketplace'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/marketplace.ts
import {
  getCollection,
  listMarketplaceOffers,
  listMyMarketplaceOffers,
  createMarketplaceOffer,
  acceptMarketplaceOffer,
  cancelMarketplaceOffer,
  deleteMarketplaceOffer,
  type CardView,
  type MarketplaceOfferSummary,
  type MyMarketplaceOffer,
} from "./api";
import { renderCardHtml, filterCardsByName } from "./card";
import { initUserHeader } from "./user-header";

export function formatDate(sqliteTimestamp: string): string {
  const iso = sqliteTimestamp.includes("T") ? sqliteTimestamp : `${sqliteTimestamp.replace(" ", "T")}Z`;
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export function renderMarketplaceCard(
  item: { cardId: string; name: string; rarity: CardView["rarity"]; imagePath: string },
  badgeHtml: string
): string {
  const displayCard: CardView = {
    id: item.cardId,
    name: item.name,
    rarity: item.rarity,
    imagePath: item.imagePath,
    quantity: 1,
    generation: 0,
  };
  return renderCardHtml(displayCard, badgeHtml);
}

export function renderPublicOfferCard(offer: MarketplaceOfferSummary): string {
  const canAccept = offer.demand.viewerQuantity > 0;
  return `
    <div class="mp-offer-card" data-offer-id="${offer.id}">
      <div class="mp-offer-card-header">
        <span>Oferta de ${offer.creatorUsername}</span>
        <span>${formatDate(offer.createdAt)}</span>
      </div>
      <div class="mp-offer-card-body">
        <div>
          <p class="mp-label">Demanda</p>
          ${renderMarketplaceCard(offer.demand, `<span class="mp-have">Tienes ${offer.demand.viewerQuantity}</span>`)}
        </div>
        <div>
          <p class="mp-label">Ofrece</p>
          <div class="mp-grid">
            ${offer.offerItems
              .map((i) => renderMarketplaceCard(i, `<span class="mp-have">Tienes ${i.viewerQuantity}</span>`))
              .join("")}
          </div>
        </div>
      </div>
      <button type="button" class="btn mp-accept-btn" data-id="${offer.id}" ${canAccept ? "" : 'disabled title="No tienes este cromo"'}>Aceptar</button>
    </div>
  `;
}

export function renderMyOfferCard(offer: MyMarketplaceOffer): string {
  const action =
    offer.status === "active"
      ? `<button type="button" class="btn mp-cancel-btn" data-id="${offer.id}">Cancelar</button>`
      : `<button type="button" class="btn mp-delete-btn" data-id="${offer.id}">Eliminar</button>`;
  return `
    <div class="mp-offer-card" data-offer-id="${offer.id}">
      <div class="mp-offer-card-header">
        <span>${offer.status === "accepted" ? "Aceptada" : "Activa"}</span>
        <span>${formatDate(offer.createdAt)}</span>
      </div>
      <div class="mp-offer-card-body">
        <div>
          <p class="mp-label">Demanda</p>
          ${renderMarketplaceCard(offer.demand, "")}
        </div>
        <div>
          <p class="mp-label">Ofrece</p>
          <div class="mp-grid">
            ${offer.offerItems.map((i) => renderMarketplaceCard(i, `<span class="mp-qty">x${i.quantity}</span>`)).join("")}
          </div>
        </div>
      </div>
      ${action}
    </div>
  `;
}

let allCards: CardView[] = [];
let currentPage = 1;
let demandFilter = "";
let offerFilter = "";

async function loadPublicView(): Promise<void> {
  const { offers, totalCount, pageSize } = await listMarketplaceOffers({
    page: currentPage,
    demandQuery: demandFilter,
    offerQuery: offerFilter,
  });
  document.getElementById("mp-public-grid")!.innerHTML = offers.map(renderPublicOfferCard).join("");
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  document.getElementById("mp-page-label")!.textContent = `Página ${currentPage} de ${totalPages}`;
  (document.getElementById("mp-prev-page") as HTMLButtonElement).disabled = currentPage <= 1;
  (document.getElementById("mp-next-page") as HTMLButtonElement).disabled = currentPage >= totalPages;
}

async function loadMineView(): Promise<void> {
  const { offers } = await listMyMarketplaceOffers();
  document.getElementById("mp-mine-grid")!.innerHTML = offers.map(renderMyOfferCard).join("");
}

function showTab(tab: "public" | "mine"): void {
  document.getElementById("mp-public-view")!.hidden = tab !== "public";
  document.getElementById("mp-mine-view")!.hidden = tab !== "mine";
  if (tab === "public") loadPublicView();
  else loadMineView();
}

function openAcceptModal(offerId: number): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <p>¿Seguro que quieres aceptar esta oferta? El intercambio se realiza inmediatamente.</p>
      <button type="button" class="btn" id="mp-accept-confirm">Aceptar</button>
      <button type="button" class="btn modal-cancel-btn" id="mp-accept-cancel">Cancelar</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#mp-accept-cancel")!.addEventListener("click", () => overlay.remove());
  overlay.querySelector("#mp-accept-confirm")!.addEventListener("click", async () => {
    await acceptMarketplaceOffer(offerId);
    overlay.remove();
    loadPublicView();
  });
}

function wireStaticEvents(): void {
  document.getElementById("mp-tab-public")!.addEventListener("click", () => showTab("public"));
  document.getElementById("mp-tab-mine")!.addEventListener("click", () => showTab("mine"));
  document.getElementById("mp-demand-filter")!.addEventListener("input", (e) => {
    demandFilter = (e.target as HTMLInputElement).value;
    currentPage = 1;
    loadPublicView();
  });
  document.getElementById("mp-offer-filter")!.addEventListener("input", (e) => {
    offerFilter = (e.target as HTMLInputElement).value;
    currentPage = 1;
    loadPublicView();
  });
  document.getElementById("mp-prev-page")!.addEventListener("click", () => {
    currentPage--;
    loadPublicView();
  });
  document.getElementById("mp-next-page")!.addEventListener("click", () => {
    currentPage++;
    loadPublicView();
  });
  document.getElementById("mp-public-grid")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mp-accept-btn");
    if (!btn || btn.disabled) return;
    openAcceptModal(Number(btn.dataset.id));
  });
  document.getElementById("mp-mine-grid")!.addEventListener("click", async (e) => {
    const cancelBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mp-cancel-btn");
    const deleteBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mp-delete-btn");
    if (cancelBtn) {
      await cancelMarketplaceOffer(Number(cancelBtn.dataset.id));
      loadMineView();
    } else if (deleteBtn) {
      await deleteMarketplaceOffer(Number(deleteBtn.dataset.id));
      loadMineView();
    }
  });
}

async function init(): Promise<void> {
  initUserHeader();
  wireStaticEvents();
  const collection = await getCollection();
  allCards = collection.cards;
  void allCards; // consumed by the creation wizard added in Task 9
  const params = new URLSearchParams(window.location.search);
  showTab(params.get("tab") === "mine" ? "mine" : "public");
}

init();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/marketplace.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Add CSS**

Append to `src/style.css`:

```css
.mp-tabs {
  display: flex;
  gap: 0.6rem;
  margin-bottom: 1rem;
}
.mp-filters {
  display: flex;
  gap: 0.6rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.mp-filters .input {
  flex: 1;
  min-width: 200px;
}
.mp-grid-offers {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
}
.mp-grid-mine {
  grid-template-columns: repeat(2, 1fr);
}
.mp-offer-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.mp-offer-card-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  color: var(--muted);
}
.mp-offer-card-body {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 1rem;
}
.mp-label {
  font-weight: 700;
  font-size: 0.75rem;
  color: var(--text-em);
  margin-bottom: 0.4rem;
}
.mp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 0.5rem;
}
.mp-have,
.mp-qty {
  display: block;
  font-size: 0.7rem;
  color: var(--muted);
  text-align: center;
}
.mp-pagination {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  justify-content: center;
  margin-top: 1rem;
}
```

- [ ] **Step 6: Type-check and run full frontend test suite**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/marketplace.ts src/marketplace.test.ts src/style.css
git commit -m "feat: add marketplace public/mine listing, filters, pagination, accept modal"
```

---

### Task 9: Creation wizard (3-step modal)

**Files:**
- Modify: `src/marketplace.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `allCards: CardView[]` (populated in Task 8's `init()`), `createMarketplaceOffer` from Task 6, `filterCardsByName` from `./card`, `renderMarketplaceCard`/`loadMineView` already defined in Task 8.

- [ ] **Step 1: Replace the `void allCards;` placeholder and add the wizard**

In `src/marketplace.ts`, remove the line `void allCards; // consumed by the creation wizard added in Task 9` and add, after `wireStaticEvents()`'s definition:

```ts
let wizardDemand: CardView | null = null;
const wizardOfferQuantities = new Map<string, number>();

function openCreateWizard(): void {
  let step = 1;
  wizardDemand = null;
  wizardOfferQuantities.clear();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal mp-wizard">
      <div class="mp-wizard-progress">
        <span class="mp-wizard-step active" data-step="1">1. Demanda</span>
        <span class="mp-wizard-step" data-step="2">2. Oferta</span>
        <span class="mp-wizard-step" data-step="3">3. Confirmación</span>
      </div>
      <div class="mp-wizard-panel" data-panel="1">
        <input class="input" id="mp-demand-search" placeholder="Buscar Pokémon..." />
        <div id="mp-demand-results" class="mp-grid"></div>
      </div>
      <div class="mp-wizard-panel" data-panel="2" hidden>
        <div class="mp-wizard-offer-columns">
          <div>
            <input class="input" id="mp-offer-search" placeholder="Buscar en tu colección..." />
            <div id="mp-offer-results" class="mp-grid"></div>
          </div>
          <div>
            <p class="mp-label">Ofreces</p>
            <div id="mp-offer-preview" class="mp-grid"></div>
          </div>
        </div>
      </div>
      <div class="mp-wizard-panel" data-panel="3" hidden>
        <div class="mp-offer-card-preview">
          <div>
            <p class="mp-label">Demanda</p>
            <div id="mp-confirm-demand" class="mp-grid"></div>
          </div>
          <div>
            <p class="mp-label">Ofrece</p>
            <div id="mp-confirm-offer" class="mp-grid"></div>
          </div>
        </div>
      </div>
      <p class="mp-wizard-error" id="mp-wizard-error" hidden></p>
      <div class="mp-wizard-actions">
        <button type="button" class="btn modal-cancel-btn" id="mp-wizard-close">Cancelar</button>
        <button type="button" class="btn" id="mp-wizard-back" hidden>Atrás</button>
        <button type="button" class="btn" id="mp-wizard-next" disabled>Siguiente</button>
        <button type="button" class="btn" id="mp-wizard-submit" hidden>Crear oferta</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const demandSearch = overlay.querySelector<HTMLInputElement>("#mp-demand-search")!;
  const demandResults = overlay.querySelector<HTMLElement>("#mp-demand-results")!;
  const offerSearch = overlay.querySelector<HTMLInputElement>("#mp-offer-search")!;
  const offerResults = overlay.querySelector<HTMLElement>("#mp-offer-results")!;
  const offerPreview = overlay.querySelector<HTMLElement>("#mp-offer-preview")!;
  const confirmDemand = overlay.querySelector<HTMLElement>("#mp-confirm-demand")!;
  const confirmOffer = overlay.querySelector<HTMLElement>("#mp-confirm-offer")!;
  const nextBtn = overlay.querySelector<HTMLButtonElement>("#mp-wizard-next")!;
  const backBtn = overlay.querySelector<HTMLButtonElement>("#mp-wizard-back")!;
  const submitBtn = overlay.querySelector<HTMLButtonElement>("#mp-wizard-submit")!;
  const errorEl = overlay.querySelector<HTMLElement>("#mp-wizard-error")!;

  function renderDemandResults(): void {
    const filtered = filterCardsByName(allCards, demandSearch.value).slice(0, 30);
    demandResults.innerHTML = filtered
      .map(
        (c) =>
          `<button type="button" class="mp-pick-btn${wizardDemand?.id === c.id ? " selected" : ""}" data-card-id="${c.id}">${renderCardHtml({ ...c, quantity: 1 })}</button>`
      )
      .join("");
    nextBtn.disabled = wizardDemand === null;
  }

  function offerPreviewHtml(): string {
    return Array.from(wizardOfferQuantities, ([cardId, quantity]) => {
      const card = allCards.find((c) => c.id === cardId)!;
      return renderCardHtml({ ...card, quantity });
    }).join("");
  }

  function renderOfferResults(): void {
    const filtered = filterCardsByName(allCards, offerSearch.value).filter((c) => c.quantity > 0);
    offerResults.innerHTML = filtered
      .map((c) => {
        const value = wizardOfferQuantities.get(c.id) ?? 0;
        const input = `<input type="number" class="input mp-offer-qty-input" data-card-id="${c.id}" min="0" max="${c.quantity}" value="${value}" style="margin-top:0.5rem;width:100%;" />`;
        return renderCardHtml(c, input);
      })
      .join("");
    offerPreview.innerHTML = offerPreviewHtml();
  }

  demandSearch.addEventListener("input", renderDemandResults);
  demandResults.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".mp-pick-btn");
    if (!btn) return;
    wizardDemand = allCards.find((c) => c.id === btn.dataset.cardId) ?? null;
    renderDemandResults();
  });

  offerSearch.addEventListener("input", renderOfferResults);
  offerResults.addEventListener("input", (e) => {
    const input = e.target as HTMLElement;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains("mp-offer-qty-input")) return;
    const cardId = input.dataset.cardId!;
    const value = Number(input.value);
    if (value > 0) wizardOfferQuantities.set(cardId, value);
    else wizardOfferQuantities.delete(cardId);
    offerPreview.innerHTML = offerPreviewHtml();
    nextBtn.disabled = wizardOfferQuantities.size === 0;
  });

  function showStep(n: number): void {
    step = n;
    overlay.querySelectorAll<HTMLElement>(".mp-wizard-step").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.step) === n);
    });
    overlay.querySelectorAll<HTMLElement>(".mp-wizard-panel").forEach((el) => {
      el.hidden = Number(el.dataset.panel) !== n;
    });
    backBtn.hidden = n === 1;
    nextBtn.hidden = n === 3;
    submitBtn.hidden = n !== 3;
    if (n === 1) nextBtn.disabled = wizardDemand === null;
    if (n === 2) {
      renderOfferResults();
      nextBtn.disabled = wizardOfferQuantities.size === 0;
    }
    if (n === 3) {
      confirmDemand.innerHTML = renderCardHtml({ ...wizardDemand!, quantity: 1 });
      confirmOffer.innerHTML = offerPreviewHtml();
    }
  }

  nextBtn.addEventListener("click", () => showStep(step + 1));
  backBtn.addEventListener("click", () => showStep(step - 1));

  submitBtn.addEventListener("click", async () => {
    errorEl.hidden = true;
    try {
      await createMarketplaceOffer({
        demandCardId: wizardDemand!.id,
        offerItems: Array.from(wizardOfferQuantities, ([cardId, quantity]) => ({ cardId, quantity })),
      });
      overlay.remove();
      loadMineView();
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : "Error al crear la oferta";
      errorEl.hidden = false;
    }
  });

  overlay.querySelector("#mp-wizard-close")!.addEventListener("click", () => overlay.remove());

  renderDemandResults();
  showStep(1);
}
```

Also add this line inside `wireStaticEvents()` (Task 8's function), alongside the other `addEventListener` calls:

```ts
  document.getElementById("mp-create-btn")!.addEventListener("click", openCreateWizard);
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Add wizard CSS**

Append to `src/style.css`:

```css
.mp-wizard {
  min-width: min(90vw, 640px);
  max-height: 85vh;
  overflow-y: auto;
}
.mp-wizard-progress {
  display: flex;
  gap: 0.8rem;
  margin-bottom: 1rem;
  font-size: 0.8rem;
  color: var(--muted);
}
.mp-wizard-step.active {
  color: var(--text-em);
  font-weight: 700;
}
.mp-wizard-offer-columns {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 1rem;
}
.mp-pick-btn {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  border-radius: 12px;
}
.mp-pick-btn.selected {
  outline: 2px solid var(--pink);
}
.mp-wizard-error {
  color: var(--pink);
  font-size: 0.8rem;
  margin-top: 0.5rem;
}
.mp-wizard-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-top: 1rem;
}
```

- [ ] **Step 4: Run full frontend and worker test suites**

Run: `npm test && npm run test:worker`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/marketplace.ts src/style.css
git commit -m "feat: add 3-step marketplace offer creation wizard"
```

---

### Task 10: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Create an offer**

Log in as user A with at least 2 owned cards. Go to `/marketplace.html`, click "Mis ofertas" → "Crear oferta". Step 1: search and pick a demanded card (confirm it can be a card you own 0 of). Step 2: search your collection, set a quantity on 1-2 cards, confirm the live preview grid updates. Step 3: confirm the preview matches, click "Crear oferta". Confirm you land back on "Mis ofertas" and the new offer shows status "Activa" with the correct demand/offer cards rendered with foil/shiny styling intact.

- [ ] **Step 3: Confirm escrow**

Go to `/collection.html` as user A — confirm the offered cards' quantity display already reflects the reservation (lower than before creating the offer). Attempt to trade those same units away via `/trade.html` — confirm it's rejected as insufficient.

- [ ] **Step 4: Accept as another user**

Log in as user B who owns the demanded card. Go to `/marketplace.html` (default "Marketplace" tab) — confirm user A's offer appears (not user A's own view), with "Tienes X" correct for both demand and offered cards. Click "Aceptar" → confirm the modal appears, confirm → confirm both collections update correctly (`/collection.html` for both users).

- [ ] **Step 5: Confirm notification**

Log back in as user A. Confirm the notification bell shows a dot; open it, confirm the message "Una oferta tuya ha sido aceptada" appears and clicking it navigates to `/marketplace.html?tab=mine` showing the offer as "Aceptada" with an "Eliminar" button.

- [ ] **Step 6: Confirm max-4 and cancel**

As user A, create offers until the 4th succeeds and a 5th is rejected with a clear error. Cancel one active offer, confirm the reserved cards return to available in `/collection.html`, and confirm a 5th can now be created.

- [ ] **Step 7: Confirm filters and pagination**

With several other users' offers in the marketplace (or manually inserted via `wrangler d1 execute --local`), confirm the demand/offer name filters narrow the list independently and together, and that pagination controls disable correctly at the first/last page.
