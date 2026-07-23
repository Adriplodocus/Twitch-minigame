# Marketplace: solo demanda, respuesta libre — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current marketplace (creator posts a fixed demand+offer bundle, anyone accepts it as-is) with an open want-ad: the creator posts only what card they want, any other user freely builds a counter-offer from the creator's own collection, and the creator accepts/declines it exactly like a normal trade offer in `offers.html`.

**Architecture:** A demand is just a discovery row (`marketplace_offers`, reused with fewer columns than before). Responding to it creates a normal `trade_offers` row (existing `trade.ts` machinery) tagged with a new `marketplace_demand_id` FK. Accepting that trade offer closes the demand and auto-declines any other pending responses to it, via one small shared helper (`closeDemand`) called from both the trade accept path and the marketplace's own cancel/expiry paths.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), vanilla TypeScript frontend, Vitest (`vitest.workers.config.ts` for anything touching `c.env.DB`, `vitest.config.ts` for plain-Node frontend logic).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-marketplace-demand-only-design.md` — read it before starting, this plan implements it section by section.
- Max 4 open demands per creator (unchanged limit, same number as the old marketplace).
- A demand's card quantity is always exactly 1 — never editable.
- 7-day expiry for demands (silent, no "Expirada" state shown) — same lifetime as today's marketplace and trade offers.
- `marketplace_offers`, `marketplace_offer_items`, `user_cards.reserved` are NOT dropped from the schema — new code simply stops writing to `marketplace_offer_items`/`reserved`. No destructive migration.
- Don't touch `src/style.css` — every markup change in this plan reuses existing `.mp-*`/`.badge`/`.offer-*` classes as-is.

---

## File Structure

| File | Change |
|---|---|
| `migrations/0025_marketplace_demand_response.sql` | Create — adds `trade_offers.marketplace_demand_id` |
| `worker/lib/marketplace-demands.ts` | Create — `closeDemand()` shared by trade accept + marketplace cancel/expiry |
| `test/lib/marketplace-demands.test.ts` | Create |
| `worker/routes/trade.ts` | Modify — accept `marketplaceDemandId` on create, call `closeDemand` on accept, expose `isMarketplaceResponse` |
| `test/routes/trade.test.ts` | Modify — append new test cases |
| `worker/routes/marketplace.ts` | Rewrite — demand-only create/list/mine/get-one/cancel, no more accept/delete/items/escrow |
| `test/routes/marketplace.test.ts` | Rewrite |
| `src/api.ts` | Modify — marketplace types/functions renamed & shrunk, `createOffer`/`TradeOfferSummary` gain the demand link |
| `src/marketplace.ts` | Rewrite — single-step create modal, simplified cards, "Responder" navigates to trade.html |
| `src/marketplace.test.ts` | Rewrite |
| `marketplace.html` | Modify — drop the offer-filter input, relabel a couple of strings |
| `src/trade.ts` | Modify — `?demandId=` entry mode, locked offer input, `marketplaceDemandId` passthrough |
| `src/offers.ts` | Modify — small "Respuesta a demanda" badge |

`trade.html` and `offers.html` need **no markup changes** — both already render everything from JS.

---

### Task 1: Migration — link trade offers to the demand they answer

**Files:**
- Create: `migrations/0025_marketplace_demand_response.sql`

**Interfaces:**
- Produces: `trade_offers.marketplace_demand_id` (nullable INTEGER, FK to `marketplace_offers(id)`) — every later task that touches `trade_offers` reads/writes this column.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE trade_offers ADD COLUMN marketplace_demand_id INTEGER REFERENCES marketplace_offers(id);
CREATE INDEX idx_trade_offers_marketplace_demand ON trade_offers(marketplace_demand_id);
```

- [ ] **Step 2: Apply it locally and confirm the test suite still boots**

Run: `npx vitest run test/routes/trade.test.ts --config vitest.workers.config.ts`
Expected: all existing tests still PASS (the new column is nullable, nothing existing references it yet — `vitest.workers.config.ts`'s `setupFiles: ["./test/apply-migrations.ts"]` auto-applies every migration in `migrations/` before tests run, so no manual `wrangler d1 migrations apply` is needed for the test DB).

- [ ] **Step 3: Commit**

```bash
git add migrations/0025_marketplace_demand_response.sql
git commit -m "feat: add trade_offers.marketplace_demand_id column"
```

---

### Task 2: `closeDemand` — shared demand-closing helper

**Files:**
- Create: `worker/lib/marketplace-demands.ts`
- Test: `test/lib/marketplace-demands.test.ts`

**Interfaces:**
- Consumes: `Env` from `worker/types` (already exists, has `.DB: D1Database`).
- Produces: `closeDemand(env: Env, demandId: number, exceptOfferId?: number): Promise<void>` — deletes the `marketplace_offers` row `demandId` and sets `status = 'declined'` on every `trade_offers` row with that `marketplace_demand_id` that is still `'pending'`, except `exceptOfferId` if given. Idempotent: calling it twice (or on an already-gone id) is a harmless no-op the second time. Used by Task 3 (trade accept) and Task 4 (marketplace cancel + expiry sweep).

- [ ] **Step 1: Write the failing tests**

```typescript
// test/lib/marketplace-demands.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import { closeDemand } from "../../worker/lib/marketplace-demands";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM trade_offers");
  await env.DB.exec("DELETE FROM marketplace_offers");
  await env.DB.exec("DELETE FROM cards");
  await env.DB.exec("DELETE FROM users");

  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1"),
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2"),
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("3", "viewer3"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "p1",
      "Pikachu",
      "common",
      "/cards/p1.png"
    ),
  ]);
});

it("deletes the demand row", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1') RETURNING id"
  ).first<{ id: number }>();

  await closeDemand(env, demandId);

  const row = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(demandId).first();
  expect(row).toBeNull();
});

it("declines every pending trade offer linked to the demand", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1') RETURNING id"
  ).first<{ id: number }>();
  const { id: offerB } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('2', '1', ?) RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();
  const { id: offerC } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('3', '1', ?) RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();

  await closeDemand(env, demandId);

  const rows = await env.DB.prepare("SELECT id, status FROM trade_offers WHERE id IN (?, ?)")
    .bind(offerB, offerC)
    .all<{ id: number; status: string }>();
  expect(rows.results).toEqual(
    expect.arrayContaining([
      { id: offerB, status: "declined" },
      { id: offerC, status: "declined" },
    ])
  );
});

it("excludes exceptOfferId from being declined", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1') RETURNING id"
  ).first<{ id: number }>();
  const { id: acceptedOffer } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id, status) VALUES ('2', '1', ?, 'accepted') RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();
  const { id: otherOffer } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('3', '1', ?) RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();

  await closeDemand(env, demandId, acceptedOffer);

  const accepted = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(acceptedOffer)
    .first<{ status: string }>();
  expect(accepted?.status).toBe("accepted"); // untouched

  const other = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(otherOffer)
    .first<{ status: string }>();
  expect(other?.status).toBe("declined");
});

it("does not touch trade offers linked to a different demand", async () => {
  const { id: demandA } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1') RETURNING id"
  ).first<{ id: number }>();
  const { id: demandB } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('2', 'p1') RETURNING id"
  ).first<{ id: number }>();
  const { id: offerOnB } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('3', '2', ?) RETURNING id"
  )
    .bind(demandB)
    .first<{ id: number }>();

  await closeDemand(env, demandA);

  const row = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerOnB)
    .first<{ status: string }>();
  expect(row?.status).toBe("pending");
});

it("is a no-op when called twice on the same already-gone demand", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1') RETURNING id"
  ).first<{ id: number }>();

  await closeDemand(env, demandId);
  await expect(closeDemand(env, demandId)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/marketplace-demands.test.ts --config vitest.workers.config.ts`
Expected: FAIL with "Cannot find module '../../worker/lib/marketplace-demands'"

- [ ] **Step 3: Write the implementation**

```typescript
// worker/lib/marketplace-demands.ts
import type { Env } from "../types";

export async function closeDemand(env: Env, demandId: number, exceptOfferId?: number): Promise<void> {
  const declineStatement =
    exceptOfferId === undefined
      ? env.DB.prepare(
          "UPDATE trade_offers SET status = 'declined' WHERE marketplace_demand_id = ? AND status = 'pending'"
        ).bind(demandId)
      : env.DB.prepare(
          "UPDATE trade_offers SET status = 'declined' WHERE marketplace_demand_id = ? AND status = 'pending' AND id != ?"
        ).bind(demandId, exceptOfferId);

  await env.DB.batch([env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ?").bind(demandId), declineStatement]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/marketplace-demands.test.ts --config vitest.workers.config.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/lib/marketplace-demands.ts test/lib/marketplace-demands.test.ts
git commit -m "feat: add closeDemand helper for closing marketplace demands"
```

---

### Task 3: `trade.ts` — link a trade offer to the demand it answers

**Files:**
- Modify: `worker/routes/trade.ts`
- Test: `test/routes/trade.test.ts`

**Interfaces:**
- Consumes: `closeDemand` from `worker/lib/marketplace-demands` (Task 2).
- Produces: `POST /api/trade/offers` accepts an optional `marketplaceDemandId: number` in its body; `GET /api/trade/offers` returns `isMarketplaceResponse: boolean` per offer. Both are consumed by the frontend in Task 5/7.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/trade.test.ts` (same file, same fixtures already in `beforeEach` — `viewer1`/`viewer2` users, card `c1` owned x3 by viewer1 and x1 by viewer2):

```typescript
it("links a trade offer to the demand it answers", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('2', 'c1') RETURNING id"
  ).first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [],
        marketplaceDemandId: demandId,
      }),
    },
    env
  );
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: number }>();

  const row = await env.DB.prepare("SELECT marketplace_demand_id FROM trade_offers WHERE id = ?")
    .bind(id)
    .first<{ marketplace_demand_id: number }>();
  expect(row?.marketplace_demand_id).toBe(demandId);
});

it("rejects linking to a demand that no longer exists", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [],
        marketplaceDemandId: 9999,
      }),
    },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects linking to a demand whose creator does not match toUsername", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES ('3', 'viewer3')").run();
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('3', 'c1') RETURNING id"
  ).first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2", // demand belongs to viewer3, not viewer2
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [],
        marketplaceDemandId: demandId,
      }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects a demand response that doesn't include the demanded card", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('2', 'c1') RETURNING id"
  ).first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [], // missing the demanded card
        requestCards: [],
        marketplaceDemandId: demandId,
      }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("closes the demand and declines sibling responses when a linked offer is accepted", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES ('3', 'viewer3')").run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES ('3', 'c1', 1)").run();

  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'c1') RETURNING id"
  ).first<{ id: number }>();

  const cookieB = await sessionCookie("2", "viewer2");
  const resB = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieB, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer1",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [],
        marketplaceDemandId: demandId,
      }),
    },
    env
  );
  const { id: offerB } = await resB.json<{ id: number }>();

  const cookieC = await sessionCookie("3", "viewer3");
  const resC = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieC, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer1",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [],
        marketplaceDemandId: demandId,
      }),
    },
    env
  );
  const { id: offerC } = await resC.json<{ id: number }>();

  const cookieCreator = await sessionCookie("1", "viewer1");
  const acceptRes = await app.request(
    `/api/trade/offers/${offerB}/accept`,
    { method: "POST", headers: { Cookie: cookieCreator } },
    env
  );
  expect(acceptRes.status).toBe(200);

  const demandRow = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(demandId).first();
  expect(demandRow).toBeNull();

  const offerCRow = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerC)
    .first<{ status: string }>();
  expect(offerCRow?.status).toBe("declined");

  // Trying to accept the now-declined sibling later correctly 409s via the existing pending-only guard.
  const secondAccept = await app.request(
    `/api/trade/offers/${offerC}/accept`,
    { method: "POST", headers: { Cookie: cookieCreator } },
    env
  );
  expect(secondAccept.status).toBe(409);
});

it("includes isMarketplaceResponse in the offers list", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('2', 'c1') RETURNING id"
  ).first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [],
        marketplaceDemandId: demandId,
      }),
    },
    env
  );
  await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );

  const res = await app.request("/api/trade/offers", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ sent: { isMarketplaceResponse: boolean }[] }>();
  expect(json.sent).toHaveLength(2);
  expect(json.sent.filter((o) => o.isMarketplaceResponse)).toHaveLength(1);
  expect(json.sent.filter((o) => !o.isMarketplaceResponse)).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/trade.test.ts --config vitest.workers.config.ts`
Expected: FAIL — the new fields/behavior don't exist yet (400s/409s where 200/201 expected, `marketplace_demand_id`/`isMarketplaceResponse` undefined).

- [ ] **Step 3: Implement**

In `worker/routes/trade.ts`, add the import:

```typescript
import { closeDemand } from "../lib/marketplace-demands";
```

Replace the `trade.post("/offers", ...)` handler body (currently lines 54–105) with:

```typescript
trade.post("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    toUsername: string;
    offerCards: TradeCardInput[];
    requestCards: TradeCardInput[];
    marketplaceDemandId?: number;
  }>();

  const offerCards = mergeByCardId(body.offerCards);
  const requestCards = mergeByCardId(body.requestCards);

  const toUser = await c.env.DB.prepare("SELECT twitch_id FROM users WHERE username = ?")
    .bind(body.toUsername)
    .first<{ twitch_id: string }>();
  if (!toUser) return c.json({ error: "Target user not found" }, 404);

  let marketplaceDemandId: number | null = null;
  if (body.marketplaceDemandId != null) {
    const demand = await c.env.DB.prepare("SELECT creator_id, demand_card_id FROM marketplace_offers WHERE id = ?")
      .bind(body.marketplaceDemandId)
      .first<{ creator_id: string; demand_card_id: string }>();
    if (!demand) return c.json({ error: "La demanda ya no está disponible" }, 409);
    if (demand.creator_id !== toUser.twitch_id) {
      return c.json({ error: "La demanda no coincide con el destinatario" }, 400);
    }
    const includesDemandCard = offerCards.some(
      (item) => item.cardId === demand.demand_card_id && item.quantity === 1
    );
    if (!includesDemandCard) return c.json({ error: "Debes ofrecer el cromo demandado" }, 400);
    marketplaceDemandId = body.marketplaceDemandId;
  }

  for (const item of offerCards) {
    const owned = await ownedQuantity(c.env, user.twitchId, item.cardId);
    if (owned < item.quantity) return c.json({ error: `You do not own enough of card ${item.cardId}` }, 409);
  }
  for (const item of requestCards) {
    const owned = await ownedQuantity(c.env, toUser.twitch_id, item.cardId);
    if (owned < item.quantity) return c.json({ error: `Target does not own enough of card ${item.cardId}` }, 409);
  }

  const offerResult = await c.env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES (?, ?, ?) RETURNING id"
  )
    .bind(user.twitchId, toUser.twitch_id, marketplaceDemandId)
    .first<{ id: number }>();
  const offerId = offerResult!.id;

  const statements = [
    ...offerCards.map((item) =>
      c.env.DB.prepare("INSERT INTO trade_items (offer_id, side, card_id, quantity) VALUES (?, 'from', ?, ?)").bind(
        offerId,
        item.cardId,
        item.quantity
      )
    ),
    ...requestCards.map((item) =>
      c.env.DB.prepare("INSERT INTO trade_items (offer_id, side, card_id, quantity) VALUES (?, 'to', ?, ?)").bind(
        offerId,
        item.cardId,
        item.quantity
      )
    ),
  ];
  if (statements.length > 0) await c.env.DB.batch(statements);

  return c.json({ id: offerId, status: "pending" }, 201);
});
```

Update `trade.get("/offers", ...)`: both the `sent` and `received` queries need `o.marketplace_demand_id IS NOT NULL AS isMarketplaceResponse` added to their `SELECT`, and `withItems` needs to carry it through as a boolean:

```typescript
  const sent = await c.env.DB.prepare(
    `SELECT o.id, u.username AS toUser, o.status, o.auto_expired AS autoExpired,
            o.marketplace_demand_id IS NOT NULL AS isMarketplaceResponse
     FROM trade_offers o JOIN users u ON u.twitch_id = o.to_user
     WHERE o.from_user = ? AND NOT o.hidden_from_sender ORDER BY o.created_at DESC`
  )
    .bind(user.twitchId)
    .all<{ id: number; toUser: string; status: string; autoExpired: number; isMarketplaceResponse: number }>();
  const received = await c.env.DB.prepare(
    `SELECT o.id, u.username AS fromUser, o.status, o.auto_expired AS autoExpired,
            o.marketplace_demand_id IS NOT NULL AS isMarketplaceResponse
     FROM trade_offers o JOIN users u ON u.twitch_id = o.from_user
     WHERE o.to_user = ? AND NOT o.hidden_from_receiver ORDER BY o.created_at DESC`
  )
    .bind(user.twitchId)
    .all<{ id: number; fromUser: string; status: string; autoExpired: number; isMarketplaceResponse: number }>();

  const allIds = [...sent.results, ...received.results].map((o) => o.id);
  const items = await itemsByOfferId(c.env, allIds);
  const withItems = <T extends { id: number; autoExpired: number; isMarketplaceResponse: number }>(offer: T) => ({
    ...offer,
    autoExpired: Boolean(offer.autoExpired),
    isMarketplaceResponse: Boolean(offer.isMarketplaceResponse),
    items: items.get(offer.id) ?? [],
  });
```

Finally, in `trade.post("/offers/:id/accept", ...)`: the initial `SELECT` needs `marketplace_demand_id`, and after the existing `await c.env.DB.batch(statements);` line, close the demand if this offer answered one:

```typescript
  const offer = await c.env.DB.prepare(
    "SELECT id, from_user, to_user, status, marketplace_demand_id FROM trade_offers WHERE id = ?"
  )
    .bind(offerId)
    .first<{ id: number; from_user: string; to_user: string; status: string; marketplace_demand_id: number | null }>();
```

```typescript
  statements.push(c.env.DB.prepare("UPDATE trade_offers SET status = 'accepted' WHERE id = ?").bind(offerId));
  await c.env.DB.batch(statements);

  if (offer.marketplace_demand_id !== null) {
    await closeDemand(c.env, offer.marketplace_demand_id, offerId);
  }

  return c.json({ status: "accepted" });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/trade.test.ts --config vitest.workers.config.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Commit**

```bash
git add worker/routes/trade.ts test/routes/trade.test.ts
git commit -m "feat: link trade offers to the marketplace demand they answer"
```

---

### Task 4: `marketplace.ts` backend — demand-only create/list/mine/cancel

**Files:**
- Modify (full rewrite): `worker/routes/marketplace.ts`
- Modify (full rewrite): `test/routes/marketplace.test.ts`

**Interfaces:**
- Consumes: `closeDemand` from `worker/lib/marketplace-demands` (Task 2).
- Produces: 
  - `POST /api/marketplace/offers { demandCardId: string }` → `201 { id: number }`
  - `GET /api/marketplace/offers?page=&demandQuery=` → `{ offers: PublicDemand[], totalCount, page, pageSize }`
  - `GET /api/marketplace/offers/mine` → `{ offers: MineDemand[] }`
  - `GET /api/marketplace/offers/:id` → `PublicDemandDetail | 404`
  - `POST /api/marketplace/offers/:id/cancel` → `{ ok: true }`
  - No more `/accept` or `DELETE /:id` routes — removed entirely.
  - Shapes consumed by Task 6 (frontend): `PublicDemand = { id, creatorUsername, createdAt, demand: { cardId, name, rarity, imagePath, viewerQuantity } }`, `MineDemand = { id, createdAt, demand: { cardId, name, rarity, imagePath } }`, `PublicDemandDetail = { id, creatorUsername, demand: { cardId, name, rarity, imagePath } }`.

- [ ] **Step 1: Write the failing tests (full file rewrite)**

Replace the entire contents of `test/routes/marketplace.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM trade_offers");
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

it("creates a demand", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: number }>();

  const row = await env.DB.prepare("SELECT creator_id, demand_card_id FROM marketplace_offers WHERE id = ?")
    .bind(id)
    .first<{ creator_id: string; demand_card_id: string }>();
  expect(row).toEqual({ creator_id: "1", demand_card_id: "p1" });
});

it("rejects a demand for a card that doesn't exist", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "nope" }) },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects a 5th demand once the creator already has 4", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1')"),
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1')"),
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1')"),
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1')"),
  ]);
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects unauthenticated requests", async () => {
  const res = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  expect(res.status).toBe(401);
});

it("lists only the current user's demands", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1')"),
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('2', 'p1')"),
  ]);
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ offers: { id: number; demand: { name: string } }[] }>();
  expect(json.offers).toHaveLength(1);
  expect(json.offers[0].demand.name).toBe("Pikachu");
});

it("cancels a demand", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const res = await app.request(`/api/marketplace/offers/${id}/cancel`, { method: "POST", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);

  const row = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(id).first();
  expect(row).toBeNull();
});

it("cancelling a demand declines its pending responses", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id: demandId } = await createRes.json<{ id: number }>();
  const { id: offerId } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('2', '1', ?) RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();

  await app.request(`/api/marketplace/offers/${demandId}/cancel`, { method: "POST", headers: { Cookie: cookie } }, env);

  const offerRow = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string }>();
  expect(offerRow?.status).toBe("declined");
});

it("rejects cancelling someone else's demand", async () => {
  const cookieCreator = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookieCreator, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cookieOther = await sessionCookie("2", "viewer2");
  const res = await app.request(`/api/marketplace/offers/${id}/cancel`, { method: "POST", headers: { Cookie: cookieOther } }, env);
  expect(res.status).toBe(404);
});

it("silently expires a demand older than 7 days and declines its pending responses", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id: demandId } = await createRes.json<{ id: number }>();
  const { id: offerId } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('2', '1', ?) RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();
  await env.DB.prepare("UPDATE marketplace_offers SET created_at = datetime('now', '-8 days') WHERE id = ?")
    .bind(demandId)
    .run();

  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === demandId)).toBeUndefined();

  const offerRow = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string }>();
  expect(offerRow?.status).toBe("declined");
});

it("does not expire a demand younger than 7 days", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === id)).toBeDefined();
});

it("excludes the viewer's own demands from the public listing", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const res = await app.request("/api/marketplace/offers", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: unknown[] }>();
  expect(json.offers).toHaveLength(0);
});

it("shows another user's demand with the viewer's owned quantity of the demanded card", async () => {
  const cookieCreator = await sessionCookie("2", "viewer2");
  await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookieCreator, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "c1" }) },
    env
  );

  const cookieViewer = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers", { headers: { Cookie: cookieViewer } }, env);
  const json = await res.json<{
    offers: { creatorUsername: string; demand: { cardId: string; viewerQuantity: number } }[];
  }>();
  expect(json.offers).toHaveLength(1);
  expect(json.offers[0].creatorUsername).toBe("viewer2");
  expect(json.offers[0].demand.viewerQuantity).toBe(3); // viewer1 owns 3 of c1
});

it("filters the public listing by demand card name", async () => {
  const cookieCreator = await sessionCookie("2", "viewer2");
  await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookieCreator, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );

  const cookieViewer = await sessionCookie("1", "viewer1");
  const matchRes = await app.request("/api/marketplace/offers?demandQuery=pika", { headers: { Cookie: cookieViewer } }, env);
  expect((await matchRes.json<{ offers: unknown[] }>()).offers).toHaveLength(1);

  const noMatchRes = await app.request("/api/marketplace/offers?demandQuery=zzz", { headers: { Cookie: cookieViewer } }, env);
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

  const offerStatements = [];
  for (let i = 0; i < 8; i++) {
    offerStatements.push(
      env.DB.prepare(
        "INSERT INTO marketplace_offers (creator_id, demand_card_id, created_at) VALUES (?, 'p1', datetime('now', ?))"
      ).bind(`page-user-${i}`, `-${i} minutes`)
    );
  }
  await env.DB.batch(offerStatements);

  const cookieViewer = await sessionCookie("1", "viewer1");
  const page1Res = await app.request("/api/marketplace/offers?page=1", { headers: { Cookie: cookieViewer } }, env);
  const page1 = await page1Res.json<{ offers: { creatorUsername: string }[]; totalCount: number; pageSize: number }>();
  expect(page1.pageSize).toBe(6);
  expect(page1.totalCount).toBe(8);
  expect(page1.offers).toHaveLength(6);
  expect(page1.offers[0].creatorUsername).toBe("pageuser0");

  const page2Res = await app.request("/api/marketplace/offers?page=2", { headers: { Cookie: cookieViewer } }, env);
  const page2 = await page2Res.json<{ offers: { creatorUsername: string }[] }>();
  expect(page2.offers).toHaveLength(2);
  expect(page2.offers[1].creatorUsername).toBe("pageuser7");
});

it("gets a single demand by id for the trade.html prefill", async () => {
  const cookieCreator = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookieCreator, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cookieViewer = await sessionCookie("1", "viewer1");
  const res = await app.request(`/api/marketplace/offers/${id}`, { headers: { Cookie: cookieViewer } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ id: number; creatorUsername: string; demand: { cardId: string; name: string } }>();
  expect(json).toEqual({ id, creatorUsername: "viewer2", demand: { cardId: "p1", name: "Pikachu", rarity: "common", imagePath: "/cards/p1.png" } });
});

it("404s getting a demand that doesn't exist", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers/9999", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/marketplace.test.ts --config vitest.workers.config.ts`
Expected: FAIL — current route file still expects `offerItems`, still has `/accept`/`DELETE` routes, `/mine` still returns `status`/`acceptedAt`/`offerItems`.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `worker/routes/marketplace.ts`:

```typescript
import { Hono } from "hono";
import type { Env, SessionUser } from "../types";
import { requireAuth } from "../middleware/auth";
import { closeDemand } from "../lib/marketplace-demands";

const marketplace = new Hono<{ Bindings: Env; Variables: { user: SessionUser } }>();

const MAX_DEMANDS_PER_USER = 4;
const DEMAND_LIFETIME_DAYS = 7;
const PAGE_SIZE = 6;

async function sweepExpiredDemands(env: Env): Promise<void> {
  const expired = await env.DB.prepare(
    "SELECT id FROM marketplace_offers WHERE created_at <= datetime('now', ?)"
  )
    .bind(`-${DEMAND_LIFETIME_DAYS} days`)
    .all<{ id: number }>();
  for (const { id } of expired.results) {
    await closeDemand(env, id);
  }
}

marketplace.post("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ demandCardId?: string }>();
  if (!body.demandCardId) return c.json({ error: "Falta el cromo demandado" }, 400);

  const demandCard = await c.env.DB.prepare("SELECT 1 FROM cards WHERE id = ?").bind(body.demandCardId).first();
  if (!demandCard) return c.json({ error: "Carta demandada no existe" }, 400);

  const countRow = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM marketplace_offers WHERE creator_id = ?")
    .bind(user.twitchId)
    .first<{ count: number }>();
  if ((countRow?.count ?? 0) >= MAX_DEMANDS_PER_USER) {
    return c.json({ error: "Tienes el máximo de demandas, elimina alguna antes de crear otra" }, 409);
  }

  const result = await c.env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES (?, ?) RETURNING id")
    .bind(user.twitchId, body.demandCardId)
    .first<{ id: number }>();

  return c.json({ id: result!.id }, 201);
});

interface MineDemandRow {
  id: number;
  createdAt: string;
  demandCardId: string;
  demandName: string;
  demandRarity: string;
  demandImagePath: string;
}

marketplace.get("/offers/mine", requireAuth, async (c) => {
  const user = c.get("user");
  await sweepExpiredDemands(c.env);

  const offers = await c.env.DB.prepare(
    `SELECT o.id, o.created_at AS createdAt,
            dc.id AS demandCardId, dc.name AS demandName, dc.rarity AS demandRarity, dc.image_path AS demandImagePath
     FROM marketplace_offers o JOIN cards dc ON dc.id = o.demand_card_id
     WHERE o.creator_id = ? ORDER BY o.created_at DESC`
  )
    .bind(user.twitchId)
    .all<MineDemandRow>();

  return c.json({
    offers: offers.results.map((o) => ({
      id: o.id,
      createdAt: o.createdAt,
      demand: { cardId: o.demandCardId, name: o.demandName, rarity: o.demandRarity, imagePath: o.demandImagePath },
    })),
  });
});

interface SingleDemandRow {
  id: number;
  creatorUsername: string;
  demandCardId: string;
  demandName: string;
  demandRarity: string;
  demandImagePath: string;
}

marketplace.get("/offers/:id", requireAuth, async (c) => {
  await sweepExpiredDemands(c.env);
  const id = Number(c.req.param("id"));

  const row = await c.env.DB.prepare(
    `SELECT o.id, u.username AS creatorUsername,
            dc.id AS demandCardId, dc.name AS demandName, dc.rarity AS demandRarity, dc.image_path AS demandImagePath
     FROM marketplace_offers o
     JOIN users u ON u.twitch_id = o.creator_id
     JOIN cards dc ON dc.id = o.demand_card_id
     WHERE o.id = ?`
  )
    .bind(id)
    .first<SingleDemandRow>();
  if (!row) return c.json({ error: "Not found" }, 404);

  return c.json({
    id: row.id,
    creatorUsername: row.creatorUsername,
    demand: { cardId: row.demandCardId, name: row.demandName, rarity: row.demandRarity, imagePath: row.demandImagePath },
  });
});

marketplace.post("/offers/:id/cancel", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT creator_id FROM marketplace_offers WHERE id = ?")
    .bind(offerId)
    .first<{ creator_id: string }>();
  if (!offer || offer.creator_id !== user.twitchId) return c.json({ error: "Not found" }, 404);

  await closeDemand(c.env, offerId);
  return c.json({ ok: true });
});

interface PublicDemandRow {
  id: number;
  creatorUsername: string;
  createdAt: string;
  demandCardId: string;
  demandName: string;
  demandRarity: string;
  demandImagePath: string;
  demandViewerQty: number;
}

marketplace.get("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  await sweepExpiredDemands(c.env);

  const page = Math.max(1, Number(c.req.query("page") ?? "1"));
  const demandQuery = c.req.query("demandQuery") ?? "";
  const offset = (page - 1) * PAGE_SIZE;

  const whereClause = `o.creator_id != ? AND (? = '' OR dc.name LIKE '%' || ? || '%')`;
  const filterParams = [user.twitchId, demandQuery, demandQuery];

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM marketplace_offers o JOIN cards dc ON dc.id = o.demand_card_id WHERE ${whereClause}`
  )
    .bind(...filterParams)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT o.id, u.username AS creatorUsername, o.created_at AS createdAt,
            dc.id AS demandCardId, dc.name AS demandName, dc.rarity AS demandRarity, dc.image_path AS demandImagePath,
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
    .all<PublicDemandRow>();

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
    })),
    totalCount: countRow?.count ?? 0,
    page,
    pageSize: PAGE_SIZE,
  });
});

export default marketplace;
```

Note the route order: `/offers/mine` and `/offers/:id` are both registered **before** the plain `/offers` GET, and `/offers/mine` comes before `/offers/:id` — Hono matches in registration order, so the literal `mine` segment must win over the `:id` pattern.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/marketplace.test.ts --config vitest.workers.config.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full worker test suite to check nothing else broke**

Run: `npm run test:worker`
Expected: PASS (this also re-runs Task 3's `trade.test.ts` and Task 2's `marketplace-demands.test.ts`)

- [ ] **Step 6: Commit**

```bash
git add worker/routes/marketplace.ts test/routes/marketplace.test.ts
git commit -m "feat: rewrite marketplace backend as demand-only, no more direct accept"
```

---

### Task 5: `src/api.ts` — frontend types and calls for the new shapes

**Files:**
- Modify: `src/api.ts`

**Interfaces:**
- Consumes: response shapes produced by Task 3 (`isMarketplaceResponse` on `TradeOfferSummary`) and Task 4 (`PublicDemand`/`MineDemand`/`PublicDemandDetail`).
- Produces: `MarketplaceDemandSummary`, `MyMarketplaceDemand`, `MarketplaceDemandDetail` types; `listMarketplaceDemands`, `listMyMarketplaceDemands`, `getMarketplaceDemand`, `createMarketplaceDemand`, `cancelMarketplaceDemand` functions; `createOffer` gains `marketplaceDemandId?: number`; `TradeOfferSummary` gains `isMarketplaceResponse: boolean`. All consumed by Tasks 6 and 7.

This task has no independent test file of its own (`src/api.ts` is a thin fetch wrapper with no branching logic to unit test — matches how the rest of the file is already untested). It's verified transitively by Task 6's tests (which import and call these functions) and by `tsc`/the build.

- [ ] **Step 1: Remove the old marketplace types and functions**

In `src/api.ts`, delete these (lines 170–232 in the current file — `MarketplaceCardView` through `deleteMarketplaceOffer`):

```typescript
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

- [ ] **Step 2: Add the replacements in the same spot**

```typescript
export interface MarketplaceDemandSummary {
  id: number;
  creatorUsername: string;
  createdAt: string;
  demand: { cardId: string; name: string; rarity: Rarity; imagePath: string; viewerQuantity: number };
}

export interface MyMarketplaceDemand {
  id: number;
  createdAt: string;
  demand: { cardId: string; name: string; rarity: Rarity; imagePath: string };
}

export interface MarketplaceDemandDetail {
  id: number;
  creatorUsername: string;
  demand: { cardId: string; name: string; rarity: Rarity; imagePath: string };
}

export function listMarketplaceDemands(params: {
  page: number;
  demandQuery?: string;
}): Promise<{ offers: MarketplaceDemandSummary[]; totalCount: number; page: number; pageSize: number }> {
  const q = new URLSearchParams({ page: String(params.page) });
  if (params.demandQuery) q.set("demandQuery", params.demandQuery);
  return request(`/marketplace/offers?${q.toString()}`);
}

export function listMyMarketplaceDemands(): Promise<{ offers: MyMarketplaceDemand[] }> {
  return request("/marketplace/offers/mine");
}

export function getMarketplaceDemand(id: number): Promise<MarketplaceDemandDetail> {
  return request(`/marketplace/offers/${id}`);
}

export function createMarketplaceDemand(input: { demandCardId: string }): Promise<{ id: number }> {
  return request("/marketplace/offers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function cancelMarketplaceDemand(id: number): Promise<{ ok: boolean }> {
  return request(`/marketplace/offers/${id}/cancel`, { method: "POST" });
}
```

- [ ] **Step 3: Update `createOffer` and `TradeOfferSummary`**

Find the existing `TradeOfferSummary` interface and add the new field:

```typescript
export interface TradeOfferSummary {
  id: number;
  status: string;
  autoExpired: boolean;
  isMarketplaceResponse: boolean;
  toUser?: string;
  fromUser?: string;
  items: TradeOfferItem[];
}
```

Find `createOffer` and add the optional field:

```typescript
export function createOffer(input: {
  toUsername: string;
  offerCards: { cardId: string; quantity: number }[];
  requestCards: { cardId: string; quantity: number }[];
  marketplaceDemandId?: number;
}): Promise<{ id: number; status: string }> {
  return request("/trade/offers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: errors only in `src/marketplace.ts` (still using the old names — fixed in Task 6) and possibly none yet in `src/trade.ts`/`src/offers.ts` (fixed in Tasks 7/8). Confirm there are no errors reported *inside `src/api.ts` itself*.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts
git commit -m "feat: replace marketplace offer-bundle API with demand-only API"
```

---

### Task 6: `src/marketplace.ts` + `marketplace.html` — demand-only frontend

**Files:**
- Modify (full rewrite): `src/marketplace.ts`
- Modify (full rewrite): `src/marketplace.test.ts`
- Modify: `marketplace.html`

**Interfaces:**
- Consumes: `listMarketplaceDemands`, `listMyMarketplaceDemands`, `createMarketplaceDemand`, `cancelMarketplaceDemand`, `getCollection`, `type MarketplaceDemandSummary`, `type MyMarketplaceDemand`, `type CardView` from `src/api.ts` (Task 5); `renderCardHtml`, `filterCardsByName`, `collectFemaleVariantBaseNames`, `computeFormLabels` from `src/card.ts` (unchanged).
- Produces: nothing consumed by later tasks — this is a leaf page.

- [ ] **Step 1: Write the failing tests (full file rewrite)**

Replace the entire contents of `src/marketplace.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatDate, renderPublicDemandCard, renderMyDemandCard, renderWizardPickCard } from "./marketplace";
import { computeFormLabels } from "./card";

describe("formatDate", () => {
  it("formats a SQLite timestamp as dd/mm/aaaa", () => {
    expect(formatDate("2026-07-07 10:30:00")).toBe("07/07/2026");
  });
});

describe("renderPublicDemandCard", () => {
  const offer = {
    id: 1,
    creatorUsername: "otheruser",
    createdAt: "2026-07-01 00:00:00",
    demand: { cardId: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png", viewerQuantity: 0 },
  };

  it("shows the creator username and formatted date", () => {
    const html = renderPublicDemandCard(offer);
    expect(html).toContain("Demanda de otheruser");
    expect(html).toContain("01/07/2026");
  });

  it("disables the respond button when the viewer doesn't have the demanded card", () => {
    const html = renderPublicDemandCard(offer);
    const btnMatch = html.match(/<button[^>]*class="btn mp-respond-btn"[^>]*>/)![0];
    expect(btnMatch).toContain("disabled");
  });

  it("enables the respond button when the viewer has the demanded card", () => {
    const html = renderPublicDemandCard({ ...offer, demand: { ...offer.demand, viewerQuantity: 1 } });
    const btnMatch = html.match(/<button[^>]*class="btn mp-respond-btn"[^>]*>/)![0];
    expect(btnMatch).not.toContain("disabled");
  });

  it("greys out the demand card when the viewer owns 0", () => {
    const html = renderPublicDemandCard(offer);
    expect(html).toContain("unowned");
  });

  it("does not render a spurious auto quantity badge", () => {
    const html = renderPublicDemandCard(offer);
    expect(html).not.toContain("card-qty");
  });
});

describe("renderMyDemandCard", () => {
  const demand = {
    id: 5,
    createdAt: "2026-07-01 00:00:00",
    demand: { cardId: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png" },
  };

  it("shows a Cancelar button", () => {
    const html = renderMyDemandCard(demand);
    expect(html).toContain("mp-cancel-btn");
  });

  it("does not render a spurious auto quantity badge", () => {
    const html = renderMyDemandCard(demand);
    expect(html).not.toContain("card-qty");
  });
});

describe("renderWizardPickCard", () => {
  const card = { id: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png", quantity: 0, generation: 1 };

  it("does not render an auto quantity badge, even for a card the viewer owns 0 of", () => {
    const html = renderWizardPickCard(card);
    expect(html).not.toContain("card-qty");
  });

  it("still forces quantity to 1 so VFX (foil/shiny/tiltable) stay active", () => {
    const html = renderWizardPickCard(card);
    expect(html).not.toContain("unowned");
  });

  it("strips a form variant (e.g. Mega X) out of the visible name when formLabels are provided", () => {
    const megaX = { id: "p10043", name: "Mewtwo Mega X", rarity: "legendary" as const, imagePath: "/p10043.png", quantity: 0, generation: 1, sortOrder: 150100430 };
    const megaY = { id: "p10044", name: "Mewtwo Mega Y", rarity: "legendary" as const, imagePath: "/p10044.png", quantity: 0, generation: 1, sortOrder: 150100440 };
    const formLabels = computeFormLabels([megaX, megaY]);

    const html = renderWizardPickCard(megaX, undefined, formLabels);

    expect(html).not.toContain('class="card-name">Mewtwo Mega X<');
    expect(html).toContain("Variante: X");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/marketplace.test.ts`
Expected: FAIL — `renderPublicDemandCard`/`renderMyDemandCard` don't exist yet (still named `renderPublicOfferCard`/`renderMyOfferCard` and expect `offerItems`).

- [ ] **Step 3: Rewrite `src/marketplace.ts`**

Replace the entire contents of `src/marketplace.ts`:

```typescript
import {
  getCollection,
  listMarketplaceDemands,
  listMyMarketplaceDemands,
  createMarketplaceDemand,
  cancelMarketplaceDemand,
  type CardView,
  type MarketplaceDemandSummary,
  type MyMarketplaceDemand,
} from "./api";
import { renderCardHtml, filterCardsByName, collectFemaleVariantBaseNames, computeFormLabels } from "./card";
import { initUserHeader } from "./user-header";

export function formatDate(sqliteTimestamp: string): string {
  const iso = sqliteTimestamp.includes("T") ? sqliteTimestamp : `${sqliteTimestamp.replace(" ", "T")}Z`;
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Populated once collection data loads (see init()); read here via closure
// rather than threaded through as parameters, matching collection.ts's pattern.
let femaleVariantBaseNames = new Set<string>();
let formLabels = new Map<string, string>();

export function renderMarketplaceCard(
  item: { cardId: string; name: string; rarity: CardView["rarity"]; imagePath: string },
  badgeHtml: string,
  quantity = 1,
  femaleVariantBaseNamesOverride?: Set<string>,
  formLabelsOverride?: Map<string, string>
): string {
  const displayCard: CardView = {
    id: item.cardId,
    name: item.name,
    rarity: item.rarity,
    imagePath: item.imagePath,
    quantity,
    generation: 0,
  };
  return renderCardHtml(
    displayCard,
    "",
    femaleVariantBaseNamesOverride ?? femaleVariantBaseNames,
    formLabelsOverride ?? formLabels,
    false,
    badgeHtml
  );
}

export function renderPublicDemandCard(offer: MarketplaceDemandSummary): string {
  const canRespond = offer.demand.viewerQuantity > 0;
  return `
    <div class="mp-offer-card" data-offer-id="${offer.id}">
      <div class="mp-offer-card-header">
        <span>Demanda de ${offer.creatorUsername}</span>
        <span>${formatDate(offer.createdAt)}</span>
      </div>
      <div class="mp-offer-card-body">
        <div>
          <p class="mp-label">Demanda</p>
          <div class="mp-grid">
            ${renderMarketplaceCard(offer.demand, `<span class="mp-have">Tienes ${offer.demand.viewerQuantity}</span>`, offer.demand.viewerQuantity)}
          </div>
        </div>
      </div>
      <button type="button" class="btn mp-respond-btn" data-id="${offer.id}" ${canRespond ? "" : 'disabled title="No tienes este cromo"'}>Responder</button>
    </div>
  `;
}

export function renderMyDemandCard(offer: MyMarketplaceDemand): string {
  return `
    <div class="mp-offer-card" data-offer-id="${offer.id}">
      <div class="mp-offer-card-header">
        <span>Activa</span>
        <span>${formatDate(offer.createdAt)}</span>
      </div>
      <div class="mp-offer-card-body">
        <div>
          <p class="mp-label">Demanda</p>
          <div class="mp-grid">
            ${renderMarketplaceCard(offer.demand, "")}
          </div>
        </div>
      </div>
      <button type="button" class="btn mp-cancel-btn" data-id="${offer.id}">Cancelar</button>
    </div>
  `;
}

let allCards: CardView[] = [];
let currentPage = 1;
let demandFilter = "";

async function loadPublicView(): Promise<void> {
  const { offers, totalCount, pageSize } = await listMarketplaceDemands({ page: currentPage, demandQuery: demandFilter });
  document.getElementById("mp-public-grid")!.innerHTML = offers.map(renderPublicDemandCard).join("");
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  document.getElementById("mp-page-label")!.textContent = `Página ${currentPage} de ${totalPages}`;
  (document.getElementById("mp-prev-page") as HTMLButtonElement).disabled = currentPage <= 1;
  (document.getElementById("mp-next-page") as HTMLButtonElement).disabled = currentPage >= totalPages;
}

// Mirrors backend's MAX_DEMANDS_PER_USER (worker/routes/marketplace.ts).
const MAX_DEMANDS_PER_USER = 4;

async function loadMineView(): Promise<void> {
  const { offers } = await listMyMarketplaceDemands();
  document.getElementById("mp-mine-grid")!.innerHTML = offers.map(renderMyDemandCard).join("");
  const createBtn = document.getElementById("mp-create-btn") as HTMLButtonElement;
  createBtn.disabled = offers.length >= MAX_DEMANDS_PER_USER;
  createBtn.title = createBtn.disabled ? "Tienes el máximo de demandas, elimina alguna antes de crear otra" : "";
}

function showTab(tab: "public" | "mine"): void {
  document.getElementById("mp-public-view")!.hidden = tab !== "public";
  document.getElementById("mp-mine-view")!.hidden = tab !== "mine";
  document.getElementById("mp-tab-mine")!.hidden = tab === "mine";
  document.getElementById("mp-tab-public")!.hidden = tab === "public";
  if (tab === "public") loadPublicView();
  else loadMineView();
}

function wireStaticEvents(): void {
  document.getElementById("mp-tab-public")!.addEventListener("click", () => showTab("public"));
  document.getElementById("mp-tab-mine")!.addEventListener("click", () => showTab("mine"));
  document.getElementById("mp-demand-filter")!.addEventListener("input", (e) => {
    demandFilter = (e.target as HTMLInputElement).value;
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
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mp-respond-btn");
    if (!btn || btn.disabled) return;
    window.location.href = `/trade.html?demandId=${btn.dataset.id}`;
  });
  document.getElementById("mp-mine-grid")!.addEventListener("click", async (e) => {
    const cancelBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mp-cancel-btn");
    if (!cancelBtn) return;
    const mineError = document.getElementById("mp-mine-error")!;
    try {
      await cancelMarketplaceDemand(Number(cancelBtn.dataset.id));
      mineError.hidden = true;
    } catch (err) {
      mineError.textContent = err instanceof Error ? err.message : "Error al cancelar la demanda";
      mineError.hidden = false;
    } finally {
      loadMineView();
    }
  });
  document.getElementById("mp-create-btn")!.addEventListener("click", openCreateDemandModal);
}

export function renderWizardPickCard(
  card: CardView,
  femaleVariantBaseNamesOverride?: Set<string>,
  formLabelsOverride?: Map<string, string>
): string {
  return renderCardHtml(
    { ...card, quantity: 1 },
    "",
    femaleVariantBaseNamesOverride ?? femaleVariantBaseNames,
    formLabelsOverride ?? formLabels,
    false
  );
}

let wizardDemand: CardView | null = null;

function openCreateDemandModal(): void {
  wizardDemand = null;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal mp-wizard">
      <input class="input" id="mp-demand-search" placeholder="Buscar Pokémon..." />
      <div id="mp-demand-results" class="mp-wizard-grid"></div>
      <p class="mp-wizard-error" id="mp-wizard-error" hidden></p>
      <div class="mp-wizard-actions">
        <button type="button" class="btn modal-cancel-btn" id="mp-wizard-close">Cancelar</button>
        <button type="button" class="btn" id="mp-wizard-submit" disabled>Crear demanda</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const demandSearch = overlay.querySelector<HTMLInputElement>("#mp-demand-search")!;
  const demandResults = overlay.querySelector<HTMLElement>("#mp-demand-results")!;
  const submitBtn = overlay.querySelector<HTMLButtonElement>("#mp-wizard-submit")!;
  const errorEl = overlay.querySelector<HTMLElement>("#mp-wizard-error")!;

  function renderDemandResults(): void {
    const query = demandSearch.value.trim();
    const filtered = query ? filterCardsByName(allCards, query).slice(0, 30) : [];
    demandResults.innerHTML = filtered
      .map(
        (c) =>
          `<div class="mp-pick-btn${wizardDemand?.id === c.id ? " selected" : ""}" role="button" tabindex="0" data-card-id="${c.id}">${renderCardHtml(c, "", femaleVariantBaseNames, formLabels)}</div>`
      )
      .join("");
    submitBtn.disabled = wizardDemand === null;
  }

  function pickDemand(cardId: string): void {
    wizardDemand = allCards.find((c) => c.id === cardId) ?? null;
    renderDemandResults();
  }

  demandSearch.addEventListener("input", renderDemandResults);
  demandResults.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".info-btn")) return;
    const btn = target.closest<HTMLElement>(".mp-pick-btn");
    if (!btn) return;
    pickDemand(btn.dataset.cardId!);
  });
  demandResults.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains("mp-pick-btn")) return;
    e.preventDefault();
    pickDemand(target.dataset.cardId!);
  });

  submitBtn.addEventListener("click", async () => {
    errorEl.hidden = true;
    try {
      await createMarketplaceDemand({ demandCardId: wizardDemand!.id });
      overlay.remove();
      loadMineView();
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : "Error al crear la demanda";
      errorEl.hidden = false;
    }
  });

  overlay.querySelector("#mp-wizard-close")!.addEventListener("click", () => overlay.remove());

  renderDemandResults();
}

async function init(): Promise<void> {
  initUserHeader();
  wireStaticEvents();
  const collection = await getCollection();
  allCards = collection.cards;
  femaleVariantBaseNames = collectFemaleVariantBaseNames(allCards);
  formLabels = computeFormLabels(allCards);
  const params = new URLSearchParams(window.location.search);
  showTab(params.get("tab") === "mine" ? "mine" : "public");
}

if (typeof document !== "undefined" && document.getElementById("mp-tab-public")) {
  init();
}
```

- [ ] **Step 4: Update `marketplace.html`**

In `marketplace.html`, remove the offer-filter input and relabel two strings:

```html
      <div class="mp-tabs">
        <button class="btn" id="mp-tab-public" type="button">Marketplace</button>
        <button class="btn" id="mp-tab-mine" type="button">Mis demandas</button>
      </div>

      <div id="mp-public-view">
        <div class="mp-filters">
          <input class="input" id="mp-demand-filter" placeholder="Filtrar por demanda..." />
        </div>
        <div id="mp-public-grid" class="mp-offers-grid"></div>
        <div class="mp-pagination">
          <button class="btn" id="mp-prev-page" type="button">Anterior</button>
          <span id="mp-page-label"></span>
          <button class="btn" id="mp-next-page" type="button">Siguiente</button>
        </div>
      </div>

      <div id="mp-mine-view" hidden>
        <button class="btn" id="mp-create-btn" type="button">Crear demanda</button>
        <p class="mp-wizard-error" id="mp-mine-error" hidden></p>
        <div id="mp-mine-grid" class="mp-offers-grid"></div>
      </div>
```

(This replaces the `<div class="mp-tabs">` through `<div id="mp-mine-view" hidden>...</div>` block — everything else in the file is unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/marketplace.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `src/marketplace.ts` or `marketplace.html`-adjacent code. (Errors may remain in `src/trade.ts`/`src/offers.ts` until Tasks 7/8.)

- [ ] **Step 7: Commit**

```bash
git add src/marketplace.ts src/marketplace.test.ts marketplace.html
git commit -m "feat: rewrite marketplace frontend as single-step demand posting"
```

---

### Task 7: `src/trade.ts` — respond to a demand from trade.html

**Files:**
- Modify: `src/trade.ts`

**Interfaces:**
- Consumes: `getMarketplaceDemand` from `src/api.ts` (Task 5); existing `getCollection`, `getUserCollection`, `createOffer`, `getMe`.
- Produces: nothing consumed by later tasks — leaf page.

**No automated tests for this task.** `src/trade.ts` has zero unit tests today (its functions aren't exported and the module wires up real DOM listeners unconditionally at import time — unlike `marketplace.ts`, it has no `if (typeof document...)` guard around its init call), so there's no existing harness to extend without restructuring the whole file, which is out of scope here. Verify this task with the manual QA pass in Task 9 instead.

- [ ] **Step 1: Add the `demandId` entry mode and locked-card rendering**

In `src/trade.ts`, update the import line:

```typescript
import { getCollection, getUserCollection, createOffer, getMe, getMarketplaceDemand, type CardView } from "./api";
```

Add a module-level var next to the existing ones (`currentTargetUsername`, `myCards`, etc.):

```typescript
let currentMarketplaceDemandId: number | null = null;
let lockedDemandCardId: string | null = null;
```

Update `renderSelectableCard` to lock the demanded card's input when rendering the "my cards" grid (`inputClass === "offer-qty"`):

```typescript
function renderSelectableCard(
  card: CardView,
  inputClass: string,
  quantities: Map<string, number>,
  femaleVariantBaseNames: Set<string>,
  formLabels: Map<string, string>
): string {
  if (card.quantity === 0) return "";
  const isLocked = inputClass === "offer-qty" && card.id === lockedDemandCardId;
  const value = isLocked ? 1 : quantities.get(card.id) ?? 0;
  const input = `
    <input
      type="number"
      class="input ${inputClass}"
      data-card-id="${card.id}"
      min="${isLocked ? 1 : 0}"
      max="${isLocked ? 1 : card.quantity}"
      value="${value}"
      style="margin-top: 0.5rem; width: 100%;"
      ${isLocked ? "disabled" : ""}
    />
  `;
  return renderCardHtml(card, input, femaleVariantBaseNames, formLabels);
}
```

- [ ] **Step 2: Rewrite `init()` to support `?demandId=`**

Replace the whole `init` function:

```typescript
async function init(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const demandIdParam = params.get("demandId");

  let targetUsername = params.get("with");

  if (demandIdParam) {
    try {
      const demand = await getMarketplaceDemand(Number(demandIdParam));
      targetUsername = demand.creatorUsername;
      lockedDemandCardId = demand.demand.cardId;
      currentMarketplaceDemandId = Number(demandIdParam);
    } catch {
      showError("Esta demanda ya no está disponible.");
      return;
    }
  }

  if (!targetUsername) {
    showError("Falta el usuario con quien comerciar. Pídele a alguien su enlace de trade.");
    return;
  }

  const me = await getMe();
  if (me.username === targetUsername) {
    showError("No puedes intercambiar contigo mismo.");
    return;
  }

  const myCollection = await getCollection();
  myCards = myCollection.cards;

  let target: { username: string; cards: CardView[] };
  try {
    target = await getUserCollection(targetUsername);
  } catch {
    showError(`No se encontró a ${targetUsername}.`);
    return;
  }
  targetCards = target.cards;
  currentTargetUsername = targetUsername;

  if (lockedDemandCardId) offerQuantities.set(lockedDemandCardId, 1);

  document.getElementById("trade-heading")!.textContent = `Intercambio con ${targetUsername}`;
  document.getElementById("target-heading")!.textContent = `Cartas de ${targetUsername}`;

  myFemaleVariants = collectFemaleVariantBaseNames(myCards);
  targetFemaleVariants = collectFemaleVariantBaseNames(targetCards);
  myFormLabels = computeFormLabels(myCards);
  targetFormLabels = computeFormLabels(targetCards);

  renderTargetGrid();
  renderMyGrid();
  document.getElementById("offer-builder")!.style.display = "block";
}
```

- [ ] **Step 3: Pass `marketplaceDemandId` through on submit**

Replace `sendOffer`:

```typescript
async function sendOffer(): Promise<void> {
  if (!currentTargetUsername) return;
  const offerCards = quantitiesToItems(offerQuantities);
  const requestCards = quantitiesToItems(requestQuantities);
  if (offerCards.length === 0 && requestCards.length === 0) return;

  await createOffer({
    toUsername: currentTargetUsername,
    offerCards,
    requestCards,
    ...(currentMarketplaceDemandId !== null ? { marketplaceDemandId: currentMarketplaceDemandId } : {}),
  });
  window.location.href = "/offers.html";
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `src/trade.ts`.

- [ ] **Step 5: Manual verification**

Run: `npm run dev`, then in a browser:
1. Log in as user A, go to `/marketplace.html`, create a demand for a card A doesn't own.
2. Log in as user B (who owns that card) in another session/incognito window, go to `/marketplace.html`, confirm A's demand is listed with a "Responder" button.
3. If B does NOT own the demanded card, confirm the button is disabled with the "No tienes este cromo" tooltip on some other demand card as a control case.
4. Click "Responder" on the one B can fulfill → confirm it lands on `trade.html` with A's collection shown, and the demanded card pre-selected at quantity 1 with its input disabled.
5. Pick a few cards from A's collection to request, submit → confirm redirect to `/offers.html`.
6. Log back in as A → confirm the offer appears under "Recibidas" with a "Respuesta a demanda" badge (added in Task 8) and Aceptar/Rechazar buttons.

- [ ] **Step 6: Commit**

```bash
git add src/trade.ts
git commit -m "feat: respond to a marketplace demand from trade.html"
```

---

### Task 8: `src/offers.ts` — badge for demand-originated offers

**Files:**
- Modify: `src/offers.ts`

**Interfaces:**
- Consumes: `isMarketplaceResponse` field on `TradeOfferSummary` (Task 5/3).
- Produces: nothing consumed by later tasks — leaf page.

**No automated tests for this task**, matching `src/offers.ts`'s existing untested state (same reasoning as Task 7). Verified in Task 9's manual pass.

- [ ] **Step 1: Add the badge**

In `src/offers.ts`, find `renderOffer` and add one line inside `.offer-card-header`:

```typescript
  return `<div class="offer-card">
    <div class="offer-card-header">
      <span class="offer-card-user">${username}</span>
      ${offer.isMarketplaceResponse ? '<span class="badge">Respuesta a demanda</span>' : ""}
      <span class="badge offer-status offer-status-${offer.status}">${statusLabel(offer)}</span>
    </div>
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `src/offers.ts`.

- [ ] **Step 3: Manual verification**

Covered by Task 7 Step 5, item 6 (the badge shows up on A's received offer once B's demand-response arrives).

- [ ] **Step 4: Commit**

```bash
git add src/offers.ts
git commit -m "feat: show a badge on trade offers that answer a marketplace demand"
```

---

### Task 9: Full suite + manual end-to-end pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test && npm run test:worker`
Expected: PASS, no leftover references to removed functions/types (`renderPublicOfferCard`, `MarketplaceOfferSummary`, `acceptMarketplaceOffer`, etc.) anywhere.

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Manual end-to-end walkthrough**

Run: `npm run dev`. Repeat the flow from Task 7 Step 5 in full, plus:
- Create a demand, then cancel it from "Mis demandas" → confirm it disappears from both "Mis demandas" and the other user's public listing.
- With two different users both responding to the same demand, accept one from `offers.html` → confirm the other's offer flips to "Rechazada" for its sender.
- Confirm the max-4-demands cap: create 4 demands, confirm "Crear demanda" becomes disabled with the tooltip; cancel one, confirm it re-enables.

- [ ] **Step 4: Report done**

No commit — this task is verification only. If any step fails, return to the relevant task, fix, and re-run its own tests before re-running this task.
