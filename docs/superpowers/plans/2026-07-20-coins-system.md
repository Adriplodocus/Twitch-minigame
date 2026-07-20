# Coins System (Discard + Shiny Conversion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let viewers discard duplicate cards for coins, and spend coins to convert a normal card into its shiny version.

**Architecture:** A `users.coins` column is the single source of truth for balance. Two new `POST /api/collection/*` endpoints mutate `user_cards` and `users.coins` atomically via `D1Database.batch`. The frontend surfaces the actions inside each card's existing info-tooltip (`.info-tooltip` in `src/card.ts`), dispatching `CustomEvent`s that `collection.ts` listens for and turns into API calls — mirroring how `card-tilt.ts`/`ensureInfoTooltipHandler` already attach one delegated `document` click handler per concern.

**Tech Stack:** Hono + D1 (Cloudflare Workers), Miniflare test pool (`vitest.workers.config.ts`), plain TypeScript/Vite frontend, Vitest (`vitest.config.ts`) for frontend unit tests.

## Global Constraints

Spec: `docs/superpowers/specs/2026-07-20-coins-design.md`

- Coin values (`DISCARD_VALUE`, `DISCARD_VALUE_SHINY`, `SHINY_CONVERSION_COST`), exact per rarity:
  - common: discard 5, discard shiny 40, convert cost 150
  - rare: discard 15, discard shiny 120, convert cost 400
  - epic: discard 40, discard shiny 320, convert cost 1000
  - legendary: discard 150, discard shiny 1200, convert cost 3500
- Both actions operate on **available quantity** (`quantity - reserved`), never raw `quantity`.
- Discard requires `available > 1` after the operation leaves at least 1 copy.
- Conversion requires `available >= 2` of the normal card (consumes 1, always leaves >= 1), the card must not already be shiny, and `cards` must contain an `id + "-shiny"` row.
- No history/audit table, no daily limits, no bulk actions — out of scope per spec.

---

### Task 1: Coin balance — schema, constants, and read endpoints

**Files:**
- Create: `migrations/0024_coins.sql`
- Create: `worker/lib/coins.ts`
- Modify: `worker/routes/collection.ts:8-28` (the `collection.get("/", ...)` handler)
- Modify: `worker/routes/auth.ts:10-16` (the `auth.get("/me", ...)` handler)
- Test: `test/routes/collection.test.ts`
- Test: `test/routes/auth.test.ts`

**Interfaces:**
- Produces: `worker/lib/coins.ts` exports `DISCARD_VALUE: Record<Rarity, number>`, `DISCARD_VALUE_SHINY: Record<Rarity, number>`, `SHINY_CONVERSION_COST: Record<Rarity, number>` — used by Tasks 2 and 3.
- Produces: `GET /api/collection` response gains `coins: number`. `GET /api/auth/me` response gains `coins: number`.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/collection.test.ts` (after the existing `"includes the tier of each pending pack"` test):

```ts
it("includes the user's coin balance", async () => {
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(250, "1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/collection", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(250);
});

it("defaults coin balance to 0 for a brand new user", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/collection", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(0);
});
```

Add to `test/routes/auth.test.ts` (after the existing `"accepts /me with a valid session cookie"` test):

```ts
it("includes the user's coin balance in /me", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username, coins) VALUES (?, ?, ?)")
    .bind("1", "viewer1", 75)
    .run();
  const { signSession } = await import("../../worker/lib/jwt");
  const token = await signSession({ twitchId: "1", username: "viewer1" }, env.JWT_SECRET);
  const res = await app.request("/api/auth/me", { headers: { Cookie: `session=${token}` } }, env);
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(75);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts test/routes/auth.test.ts`
Expected: FAIL — `coins` is `undefined` in both new assertions (and the `UPDATE users SET coins` in the first new test errors because the column doesn't exist yet).

- [ ] **Step 3: Add the migration**

Create `migrations/0024_coins.sql`:

```sql
ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Create the coin constants file**

Create `worker/lib/coins.ts`:

```ts
import type { Rarity } from "../types";

export const DISCARD_VALUE: Record<Rarity, number> = {
  common: 5,
  rare: 15,
  epic: 40,
  legendary: 150,
};

export const DISCARD_VALUE_SHINY: Record<Rarity, number> = {
  common: 40,
  rare: 120,
  epic: 320,
  legendary: 1200,
};

export const SHINY_CONVERSION_COST: Record<Rarity, number> = {
  common: 150,
  rare: 400,
  epic: 1000,
  legendary: 3500,
};
```

- [ ] **Step 5: Return coins from `GET /api/collection`**

In `worker/routes/collection.ts`, modify the `collection.get("/", requireAuth, async (c) => { ... })` handler (currently lines 8-28) to add a third query and include it in the response:

```ts
collection.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const cards = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.rarity, c.image_path AS imagePath, c.sort_order AS sortOrder, c.generation AS generation,
            COALESCE(uc.quantity, 0) - COALESCE(uc.reserved, 0) AS quantity, uc.updated_at AS acquiredAt
     FROM cards c
     LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = ?
     ORDER BY c.sort_order, c.id`
  )
    .bind(user.twitchId)
    .all();

  const pendingPacks = await c.env.DB.prepare(
    "SELECT id, created_at AS createdAt, tier FROM packs WHERE user_id = ? AND opened_at IS NULL ORDER BY created_at"
  )
    .bind(user.twitchId)
    .all();

  const userRow = await c.env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?")
    .bind(user.twitchId)
    .first<{ coins: number }>();

  return c.json({ cards: cards.results, pendingPacks: pendingPacks.results, coins: userRow?.coins ?? 0 });
});
```

- [ ] **Step 6: Return coins from `GET /api/auth/me`**

In `worker/routes/auth.ts`, modify the `auth.get("/me", ...)` handler (currently lines 10-16):

```ts
auth.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT avatar_url AS avatarUrl, coins FROM users WHERE twitch_id = ?")
    .bind(user.twitchId)
    .first<{ avatarUrl: string | null; coins: number }>();
  return c.json({ ok: true, username: user.username, avatarUrl: row?.avatarUrl ?? null, coins: row?.coins ?? 0 });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts test/routes/auth.test.ts`
Expected: PASS (all tests in both files, including the pre-existing ones).

- [ ] **Step 8: Commit**

```bash
git add migrations/0024_coins.sql worker/lib/coins.ts worker/routes/collection.ts worker/routes/auth.ts test/routes/collection.test.ts test/routes/auth.test.ts
git commit -m "feat: add coin balance to users, expose via /me and /collection"
```

---

### Task 2: `POST /api/collection/discard`

**Files:**
- Modify: `worker/routes/collection.ts`
- Test: `test/routes/collection.test.ts`

**Interfaces:**
- Consumes: `DISCARD_VALUE`, `DISCARD_VALUE_SHINY` from `worker/lib/coins.ts` (Task 1). `isShinyCard(id: string): boolean` from `worker/lib/packs.ts` (already exists, imported already for `pickRandomCards`).
- Produces: `POST /api/collection/discard` with body `{ cardId: string }` → `{ ok: true, coins: number }` on success; 400 invalid body/cardId, 404 unknown card, 409 nothing to discard (`available <= 1`).

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/collection.test.ts`:

```ts
it("discards a duplicate card and credits coins by rarity", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 3).run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ ok: true; coins: number }>();
  expect(json.coins).toBe(5); // common discard value

  const owned = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  expect(owned?.quantity).toBe(2);
});

it("credits the higher shiny discard value for a shiny card id", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)")
    .bind("1", "c1-shiny", 2)
    .run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1-shiny" }) },
    env
  );
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(40); // common shiny discard value
});

it("rejects discarding the only copy of a card", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 1).run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(409);

  const owned = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  expect(owned?.quantity).toBe(1);
});

it("rejects discarding a reserved copy that would drop available quantity to 0", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity, reserved) VALUES (?, ?, ?, ?)")
    .bind("1", "c1", 2, 1)
    .run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects discarding a card the user doesn't own", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects discarding an unknown cardId", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "nope" }) },
    env
  );
  expect(res.status).toBe(404);
});

it("rejects a discard request with a null body", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(null) },
    env
  );
  expect(res.status).toBe(400);
});

it("requires auth for discard", async () => {
  const res = await app.request("/api/collection/discard", { method: "POST" }, env);
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts`
Expected: FAIL — `404` for the whole route (no `/discard` handler exists yet).

- [ ] **Step 3: Implement the endpoint**

In `worker/routes/collection.ts`, add the import and the route. Update the top imports:

```ts
import { Hono } from "hono";
import type { Category, Env, Rarity } from "../types";
import { requireAuth } from "../middleware/auth";
import { pickRandomCards, isShinyCard } from "../lib/packs";
import { DISCARD_VALUE, DISCARD_VALUE_SHINY } from "../lib/coins";
```

Add this helper and route (after the `collection.get("/", ...)` handler, before `collection.post("/packs/:id/open", ...)`):

```ts
function parseCardId(body: unknown): string | null {
  const cardId = (body as { cardId?: unknown } | null)?.cardId;
  return typeof cardId === "string" && cardId.length > 0 ? cardId : null;
}

collection.post("/discard", requireAuth, async (c) => {
  const user = c.get("user");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const cardId = parseCardId(body);
  if (!cardId) return c.json({ error: "Invalid cardId" }, 400);

  const card = await c.env.DB.prepare("SELECT rarity FROM cards WHERE id = ?")
    .bind(cardId)
    .first<{ rarity: Rarity }>();
  if (!card) return c.json({ error: "Not found" }, 404);

  const owned = await c.env.DB.prepare("SELECT quantity, reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind(user.twitchId, cardId)
    .first<{ quantity: number; reserved: number }>();
  const available = (owned?.quantity ?? 0) - (owned?.reserved ?? 0);
  if (available <= 1) return c.json({ error: "Nothing to discard" }, 409);

  const value = isShinyCard(cardId) ? DISCARD_VALUE_SHINY[card.rarity] : DISCARD_VALUE[card.rarity];

  const results = await c.env.DB.batch<{ coins: number }>([
    c.env.DB.prepare("UPDATE user_cards SET quantity = quantity - 1 WHERE user_id = ? AND card_id = ?").bind(
      user.twitchId,
      cardId
    ),
    c.env.DB.prepare("UPDATE users SET coins = coins + ? WHERE twitch_id = ? RETURNING coins").bind(
      value,
      user.twitchId
    ),
  ]);
  const coins = results[results.length - 1].results[0].coins;

  return c.json({ ok: true, coins });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add worker/routes/collection.ts test/routes/collection.test.ts
git commit -m "feat: add POST /api/collection/discard"
```

---

### Task 3: `POST /api/collection/convert-shiny`

**Files:**
- Modify: `worker/routes/collection.ts`
- Test: `test/routes/collection.test.ts`

**Interfaces:**
- Consumes: `SHINY_CONVERSION_COST` from `worker/lib/coins.ts` (Task 1), `isShinyCard` from `worker/lib/packs.ts`, `parseCardId` from Task 2 (same file).
- Produces: `POST /api/collection/convert-shiny` with body `{ cardId: string }` → `{ ok: true, coins: number }`; 400 invalid body/already-shiny/not-enough-coins, 404 unknown card or no shiny counterpart, 409 not enough copies.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/collection.test.ts`:

```ts
it("converts a normal card to shiny, consuming a duplicate and coins", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 2).run();
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(200, "1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(50); // 200 - 150 (common conversion cost)

  const normal = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  expect(normal?.quantity).toBe(1);

  const shiny = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1-shiny")
    .first<{ quantity: number }>();
  expect(shiny?.quantity).toBe(1);
});

it("adds onto an existing shiny quantity instead of overwriting it", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 2),
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1-shiny", 1),
    env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(200, "1"),
  ]);

  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );

  const shiny = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1-shiny")
    .first<{ quantity: number }>();
  expect(shiny?.quantity).toBe(2);
});

it("rejects converting with only 1 available copy", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 1),
    env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(200, "1"),
  ]);

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects converting without enough coins", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 2).run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(400);

  const normal = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  expect(normal?.quantity).toBe(2); // untouched
});

it("rejects converting a card with no shiny counterpart in the catalog", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 2).run();
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(9999, "1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(404);
});

it("rejects converting a card that is already shiny", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)")
    .bind("1", "c1-shiny", 2)
    .run();
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(9999, "1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1-shiny" }) },
    env
  );
  expect(res.status).toBe(400);
});

it("requires auth for convert-shiny", async () => {
  const res = await app.request("/api/collection/convert-shiny", { method: "POST" }, env);
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts`
Expected: FAIL — `404` for the whole route (no `/convert-shiny` handler exists yet).

- [ ] **Step 3: Implement the endpoint**

In `worker/routes/collection.ts`, update the import line from Task 2 to also pull in the conversion cost:

```ts
import { DISCARD_VALUE, DISCARD_VALUE_SHINY, SHINY_CONVERSION_COST } from "../lib/coins";
```

Add this route (after the `collection.post("/discard", ...)` handler from Task 2):

```ts
collection.post("/convert-shiny", requireAuth, async (c) => {
  const user = c.get("user");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const cardId = parseCardId(body);
  if (!cardId) return c.json({ error: "Invalid cardId" }, 400);
  if (isShinyCard(cardId)) return c.json({ error: "Already shiny" }, 400);

  const shinyId = `${cardId}-shiny`;
  const [card, shinyCard, owned, userRow] = await Promise.all([
    c.env.DB.prepare("SELECT rarity FROM cards WHERE id = ?").bind(cardId).first<{ rarity: Rarity }>(),
    c.env.DB.prepare("SELECT id FROM cards WHERE id = ?").bind(shinyId).first<{ id: string }>(),
    c.env.DB.prepare("SELECT quantity, reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
      .bind(user.twitchId, cardId)
      .first<{ quantity: number; reserved: number }>(),
    c.env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?").bind(user.twitchId).first<{ coins: number }>(),
  ]);
  if (!card) return c.json({ error: "Not found" }, 404);
  if (!shinyCard) return c.json({ error: "No shiny version available" }, 404);

  const available = (owned?.quantity ?? 0) - (owned?.reserved ?? 0);
  if (available < 2) return c.json({ error: "Not enough copies" }, 409);

  const cost = SHINY_CONVERSION_COST[card.rarity];
  const coins = userRow?.coins ?? 0;
  if (coins < cost) return c.json({ error: "Not enough coins" }, 400);

  const results = await c.env.DB.batch<{ coins: number }>([
    c.env.DB.prepare("UPDATE user_cards SET quantity = quantity - 1 WHERE user_id = ? AND card_id = ?").bind(
      user.twitchId,
      cardId
    ),
    c.env.DB.prepare(
      `INSERT INTO user_cards (user_id, card_id, quantity, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP`
    ).bind(user.twitchId, shinyId),
    c.env.DB.prepare("UPDATE users SET coins = coins - ? WHERE twitch_id = ? RETURNING coins").bind(
      cost,
      user.twitchId
    ),
  ]);
  const newCoins = results[results.length - 1].results[0].coins;

  return c.json({ ok: true, coins: newCoins });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run the full worker test suite**

Run: `npm run test:worker`
Expected: PASS (no regressions in other route files).

- [ ] **Step 6: Commit**

```bash
git add worker/routes/collection.ts test/routes/collection.test.ts
git commit -m "feat: add POST /api/collection/convert-shiny"
```

---

### Task 4: Frontend API client (`api.ts`) and display constants (`coins.ts`)

**Files:**
- Modify: `src/api.ts`
- Create: `src/coins.ts`

**Interfaces:**
- Consumes: nothing new (matches the response shapes from Tasks 1-3).
- Produces: `src/coins.ts` exports `DISCARD_VALUE`, `DISCARD_VALUE_SHINY`, `SHINY_CONVERSION_COST` (`Record<Rarity, number>`, `Rarity` imported from `./api`) — used by Task 5. `src/api.ts` exports `discardCard(cardId: string): Promise<{ ok: true; coins: number }>` and `convertToShiny(cardId: string): Promise<{ ok: true; coins: number }>` — used by Task 7. `CollectionResponse` gains `coins: number`. `getMe()` return type gains `coins: number`.

This task has no dedicated test file — `src/api.ts`'s existing `request<T>` wrappers (`getCollection`, `openPack`, etc.) aren't unit-tested in this codebase either; correctness is exercised indirectly by the worker tests (Tasks 1-3) and by Tasks 5-7 consuming these functions. Validate with a type-check instead.

- [ ] **Step 1: Create `src/coins.ts`**

```ts
import type { Rarity } from "./api";

export const DISCARD_VALUE: Record<Rarity, number> = {
  common: 5,
  rare: 15,
  epic: 40,
  legendary: 150,
};

export const DISCARD_VALUE_SHINY: Record<Rarity, number> = {
  common: 40,
  rare: 120,
  epic: 320,
  legendary: 1200,
};

export const SHINY_CONVERSION_COST: Record<Rarity, number> = {
  common: 150,
  rare: 400,
  epic: 1000,
  legendary: 3500,
};
```

- [ ] **Step 2: Extend `src/api.ts`**

Modify the `CollectionResponse` interface (currently lines 22-25):

```ts
export interface CollectionResponse {
  cards: CardView[];
  pendingPacks: PendingPack[];
  coins: number;
}
```

Modify `getMe` (currently line 54-56):

```ts
export function getMe(): Promise<{ ok: boolean; username: string; avatarUrl: string | null; coins: number }> {
  return request("/auth/me");
}
```

Add these two functions after `broadcastPack` (currently ending at line 68):

```ts
export function discardCard(cardId: string): Promise<{ ok: true; coins: number }> {
  return request("/collection/discard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId }),
  });
}

export function convertToShiny(cardId: string): Promise<{ ok: true; coins: number }> {
  return request("/collection/convert-shiny", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId }),
  });
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors. (Existing callers of `getMe()`/`CollectionResponse` in `user-header.ts`/`collection.ts` aren't broken because the change only adds a required field to response *types*, and nothing destructures `coins` yet — TypeScript won't complain about an unused response field.)

- [ ] **Step 4: Commit**

```bash
git add src/api.ts src/coins.ts
git commit -m "feat: add discard/convert-shiny API client and coin value constants"
```

---

### Task 5: `card.ts` — shiny-pair detection, coin action buttons, delegated handler

**Files:**
- Modify: `src/card.ts`
- Test: `src/card.test.ts`

**Interfaces:**
- Consumes: `DISCARD_VALUE`, `DISCARD_VALUE_SHINY`, `SHINY_CONVERSION_COST` from `src/coins.ts` (Task 4).
- Produces: `collectShinyCapableIds(cards: CardView[]): Set<string>` and `CoinActionsConfig` (`{ coins: number; shinyCapableIds: Set<string> }`) — used by Task 7 (`collection.ts`). `renderCardHtml` gains a 7th optional parameter `coinActions?: CoinActionsConfig`. Renders `.coin-actions` (with `data-card-id`), `.coin-discard-btn`, `.coin-convert-wrap` > `.coin-convert-btn` / `.coin-convert-confirm` (`.coin-convert-yes` / `.coin-convert-no`) inside `.info-tooltip`. Dispatches bubbling `CustomEvent("card-discard", { detail: { cardId } })` and `CustomEvent("card-convert-shiny", { detail: { cardId } })` on click — used by Task 7.

- [ ] **Step 1: Write the failing tests**

Add to `src/card.test.ts` (add the import at the top alongside the existing ones):

```ts
import { renderCardHtml, collectShinyCapableIds } from "./card";
```

Add these tests at the end of the file:

```ts
it("collectShinyCapableIds returns ids of normal cards that have a -shiny counterpart", () => {
  const cards = [card({ id: "p1" }), card({ id: "p1-shiny" }), card({ id: "p2" })];
  const capable = collectShinyCapableIds(cards);
  expect(capable.has("p1")).toBe(true);
  expect(capable.has("p2")).toBe(false);
  expect(capable.has("p1-shiny")).toBe(false);
});

it("shows no coin action buttons when coinActions is not passed", () => {
  const html = renderCardHtml(card({ quantity: 3 }));
  expect(html).not.toContain("coin-actions");
});

it("shows the discard button with its coin value when quantity > 1", () => {
  const html = renderCardHtml(card({ id: "p1", rarity: "rare", quantity: 3 }), "", undefined, undefined, true, undefined, {
    coins: 0,
    shinyCapableIds: new Set(),
  });
  expect(html).toContain("coin-discard-btn");
  expect(html).toContain("+15"); // DISCARD_VALUE.rare
});

it("hides the discard button when quantity is 1", () => {
  const html = renderCardHtml(card({ id: "p1", quantity: 1 }), "", undefined, undefined, true, undefined, {
    coins: 0,
    shinyCapableIds: new Set(),
  });
  expect(html).not.toContain("coin-discard-btn");
});

it("uses the shiny discard value for a shiny card id", () => {
  const html = renderCardHtml(card({ id: "p1-shiny", name: "Bulbasaur Shiny", rarity: "rare", quantity: 3 }), "", undefined, undefined, true, undefined, {
    coins: 0,
    shinyCapableIds: new Set(),
  });
  expect(html).toContain("+120"); // DISCARD_VALUE_SHINY.rare
});

it("shows the convert button, enabled, when eligible and affordable", () => {
  const html = renderCardHtml(card({ id: "p1", rarity: "common", quantity: 2 }), "", undefined, undefined, true, undefined, {
    coins: 150,
    shinyCapableIds: new Set(["p1"]),
  });
  expect(html).toContain("coin-convert-btn");
  expect(html).toContain("150"); // SHINY_CONVERSION_COST.common
  expect(html).not.toMatch(/coin-convert-btn"[^>]*disabled/);
});

it("shows the convert button disabled when coins are insufficient", () => {
  const html = renderCardHtml(card({ id: "p1", rarity: "common", quantity: 2 }), "", undefined, undefined, true, undefined, {
    coins: 0,
    shinyCapableIds: new Set(["p1"]),
  });
  expect(html).toMatch(/coin-convert-btn"[^>]*disabled/);
});

it("hides the convert button when quantity is below 2", () => {
  const html = renderCardHtml(card({ id: "p1", quantity: 1 }), "", undefined, undefined, true, undefined, {
    coins: 9999,
    shinyCapableIds: new Set(["p1"]),
  });
  expect(html).not.toContain("coin-convert-btn");
});

it("hides the convert button when the card has no shiny counterpart", () => {
  const html = renderCardHtml(card({ id: "p1", quantity: 2 }), "", undefined, undefined, true, undefined, {
    coins: 9999,
    shinyCapableIds: new Set(), // p1 not in the set
  });
  expect(html).not.toContain("coin-convert-btn");
});

it("hides the convert button on a card that is already shiny", () => {
  const html = renderCardHtml(card({ id: "p1-shiny", name: "Bulbasaur Shiny", quantity: 2 }), "", undefined, undefined, true, undefined, {
    coins: 9999,
    shinyCapableIds: new Set(["p1-shiny"]), // even if (incorrectly) present, shiny cards never show convert
  });
  expect(html).not.toContain("coin-convert-btn");
});

it("hides both coin action buttons for an unowned card", () => {
  const html = renderCardHtml(card({ id: "p1", quantity: 0 }), "", undefined, undefined, true, undefined, {
    coins: 9999,
    shinyCapableIds: new Set(["p1"]),
  });
  expect(html).not.toContain("coin-actions");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/card.test.ts`
Expected: FAIL — `collectShinyCapableIds` is not exported, and none of the `coin-*` classes exist yet.

- [ ] **Step 3: Implement in `src/card.ts`**

Add the import (alongside the existing `ensureCardTiltHandler` import at the top):

```ts
import { DISCARD_VALUE, DISCARD_VALUE_SHINY, SHINY_CONVERSION_COST } from "./coins";
```

Add this function anywhere above `renderCardHtml` (e.g. right after `collectFemaleVariantBaseNames`):

```ts
export function collectShinyCapableIds(cards: CardView[]): Set<string> {
  const shinyIds = new Set(cards.filter((c) => c.id.endsWith("-shiny")).map((c) => c.id));
  const capable = new Set<string>();
  for (const c of cards) {
    if (!c.id.endsWith("-shiny") && shinyIds.has(`${c.id}-shiny`)) capable.add(c.id);
  }
  return capable;
}

export interface CoinActionsConfig {
  coins: number;
  shinyCapableIds: Set<string>;
}
```

Add the delegated click handler, mirroring `ensureInfoTooltipHandler` (place it right after that function):

```ts
let coinActionsHandlerAttached = false;

function ensureCoinActionsHandler(): void {
  if (typeof document === "undefined") return;
  if (coinActionsHandlerAttached) return;
  coinActionsHandlerAttached = true;
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    const discardBtn = target.closest<HTMLElement>(".coin-discard-btn");
    if (discardBtn) {
      const cardId = discardBtn.closest<HTMLElement>(".coin-actions")!.dataset.cardId!;
      discardBtn.dispatchEvent(new CustomEvent("card-discard", { bubbles: true, detail: { cardId } }));
      return;
    }

    const convertBtn = target.closest<HTMLElement>(".coin-convert-btn");
    if (convertBtn && !convertBtn.hasAttribute("disabled")) {
      convertBtn.closest(".coin-convert-wrap")!.classList.add("confirming");
      return;
    }

    const yesBtn = target.closest<HTMLElement>(".coin-convert-yes");
    if (yesBtn) {
      const cardId = yesBtn.closest<HTMLElement>(".coin-actions")!.dataset.cardId!;
      yesBtn.dispatchEvent(new CustomEvent("card-convert-shiny", { bubbles: true, detail: { cardId } }));
      return;
    }

    const noBtn = target.closest<HTMLElement>(".coin-convert-no");
    if (noBtn) {
      noBtn.closest(".coin-convert-wrap")!.classList.remove("confirming");
    }
  });
}
```

Now modify `renderCardHtml` itself. Change its signature (currently lines 144-151):

```ts
export function renderCardHtml(
  card: CardView,
  innerExtra = "",
  femaleVariantBaseNames?: Set<string>,
  formLabels?: Map<string, string>,
  showQtyBadge = true,
  footerBadgeHtml?: string,
  coinActions?: CoinActionsConfig
): string {
  ensureInfoTooltipHandler();
  ensureCardTiltHandler();
  ensureCoinActionsHandler();
```

Right before the existing `const infoTooltip = ...` block (currently starting at line 196), insert the coin actions HTML build — it needs `isOwned`, `isShiny`, and `card`, all already computed above that point:

```ts
  const coinActionsHtml = (() => {
    if (!coinActions || !isOwned) return "";
    const discardValue = isShiny ? DISCARD_VALUE_SHINY[card.rarity] : DISCARD_VALUE[card.rarity];
    const showDiscard = card.quantity > 1;
    const showConvert = !isShiny && coinActions.shinyCapableIds.has(card.id) && card.quantity >= 2;
    if (!showDiscard && !showConvert) return "";

    const convertCost = SHINY_CONVERSION_COST[card.rarity];
    const canAfford = coinActions.coins >= convertCost;

    return `
      <div class="coin-actions" data-card-id="${card.id}">
        ${showDiscard ? `<button type="button" class="btn coin-discard-btn">Descartar (+${discardValue})</button>` : ""}
        ${
          showConvert
            ? `<div class="coin-convert-wrap">
                <button type="button" class="btn coin-convert-btn"${canAfford ? "" : " disabled"}>Convertir a shiny (${convertCost})</button>
                <div class="coin-convert-confirm">
                  <span>¿Seguro?</span>
                  <button type="button" class="btn coin-convert-yes">Sí</button>
                  <button type="button" class="btn coin-convert-no">No</button>
                </div>
              </div>`
            : ""
        }
      </div>
    `;
  })();
```

Then add `${coinActionsHtml}` inside the `infoTooltip` template, right after the `genderLine` line:

```ts
  const infoTooltip = `
    <div class="info-tooltip">
      <p><strong>${baseName}</strong></p>
      ${formLabel ? `<p>Variante: ${formLabel}</p>` : ""}
      <p>Rareza: ${RARITY_LABELS[card.rarity]}</p>
      ${isShiny ? `<p>Shiny: Sí</p>` : ""}
      ${genderLine ? `<p>Género: ${genderLine}</p>` : ""}
      ${coinActionsHtml}
    </div>
  `;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/card.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/card.ts src/card.test.ts
git commit -m "feat: render discard/convert-to-shiny buttons in the card info tooltip"
```

---

### Task 6: `#user-coins` header element (HTML + `user-header.ts`)

**Files:**
- Modify: `collection.html:50-51`, `trade.html:41-42`, `offers.html:41-42`, `album.html:50-51`
- Modify: `src/user-header.ts`
- Test: `src/user-coins-element.test.ts` (create)

**Interfaces:**
- Consumes: `getMe()` (Task 4, now returns `coins`).
- Produces: `#user-coins` element kept in sync by `user-header.ts`; listens for `document`-level `CustomEvent("coins-updated", { detail: { coins: number } })` — dispatched by Task 7 (`collection.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/user-coins-element.test.ts` (mirrors `src/daily-pack-button.test.ts`):

```ts
// src/user-coins-element.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("user coins element", () => {
  it.each(["collection.html", "trade.html", "offers.html", "album.html"])("is present in %s", (file) => {
    const html = readFileSync(resolve(__dirname, "..", file), "utf-8");
    expect(html).toContain('id="user-coins"');
  });

  it("is absent from admin.html", () => {
    const html = readFileSync(resolve(__dirname, "..", "admin.html"), "utf-8");
    expect(html).not.toContain("user-coins");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/user-coins-element.test.ts`
Expected: FAIL — none of the 4 files contain `id="user-coins"` yet.

- [ ] **Step 3: Add the element to each of the 4 HTML files**

In each of `collection.html`, `trade.html`, `offers.html`, `album.html`, find this exact two-line block (line numbers above are for `collection.html`/`album.html`; `trade.html`/`offers.html` have the same two lines at their own line numbers):

```html
        <img id="user-avatar" class="user-avatar" alt="" />
        <span id="user-name" class="user-name"></span>
```

Replace it with:

```html
        <img id="user-avatar" class="user-avatar" alt="" />
        <span id="user-name" class="user-name"></span>
        <span id="user-coins" class="user-coins" title="Monedas"></span>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/user-coins-element.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it up in `src/user-header.ts`**

Modify the `getMe().then(...)` block (currently lines 32-39):

```ts
  getMe().then((me) => {
    document.getElementById("user-name")!.textContent = me.username;
    const avatar = document.getElementById("user-avatar") as HTMLImageElement | null;
    if (avatar) {
      avatar.alt = me.username;
      if (me.avatarUrl) avatar.src = me.avatarUrl;
    }
    const coinsEl = document.getElementById("user-coins");
    if (coinsEl) coinsEl.textContent = `${me.coins} 🪙`;
  });

  document.addEventListener("coins-updated", (e) => {
    const coinsEl = document.getElementById("user-coins");
    if (coinsEl) coinsEl.textContent = `${(e as CustomEvent<{ coins: number }>).detail.coins} 🪙`;
  });
```

- [ ] **Step 6: Add styling in `src/style.css`**

Add near `.user-name` (currently around line 883-888):

```css
.user-coins {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  color: var(--gold);
  font-size: 0.8rem;
  white-space: nowrap;
}
```

- [ ] **Step 7: Run the full frontend test suite**

Run: `npm test`
Expected: PASS (no regressions).

- [ ] **Step 8: Commit**

```bash
git add collection.html trade.html offers.html album.html src/user-header.ts src/style.css src/user-coins-element.test.ts
git commit -m "feat: show coin balance in the page header"
```

---

### Task 7: Wire coin actions into `collection.ts`

**Files:**
- Modify: `src/collection.ts`
- Modify: `collection.html`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `discardCard`, `convertToShiny` (Task 4), `collectShinyCapableIds`, `CoinActionsConfig` (Task 5), `#user-coins`/`coins-updated` (Task 6).
- Produces: fully working discard/convert UI on the collection page. No new exports — this is the integration point, validated manually per project convention (`collection.ts` has no existing unit test file; page wiring in this codebase is verified in the browser, see `src/collection.ts`'s existing untested `openPack`/`revealPack` flow).

- [ ] **Step 1: Add an error element to `collection.html`**

Find (around line 91):

```html
      <h2 id="owned-heading" class="section-heading"></h2>
```

Replace with:

```html
      <h2 id="owned-heading" class="section-heading"></h2>
      <p id="coin-action-error" class="coin-action-error" hidden></p>
```

- [ ] **Step 2: Add styling in `src/style.css`**

Add near the `.coin-actions`-adjacent rules (anywhere after the `.info-tooltip` block, e.g. right after line 454):

```css
.coin-actions {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: 0.4rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--border);
}
.coin-actions .btn {
  font-size: 0.55rem;
  padding: 0.3rem 0.5rem;
  justify-content: center;
}
.coin-convert-confirm {
  display: none;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.55rem;
}
.coin-convert-wrap.confirming .coin-convert-btn { display: none; }
.coin-convert-wrap.confirming .coin-convert-confirm { display: flex; }
.coin-convert-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.coin-action-error {
  margin-top: 0.75rem;
  color: #e5173a;
  font-size: 0.8rem;
}
.coin-action-error[hidden] { display: none; }
```

- [ ] **Step 3: Wire state and event listeners in `src/collection.ts`**

Update the imports at the top of the file:

```ts
import { getCollection, openPack, broadcastPack, discardCard, convertToShiny, type CardView, type PendingPack } from "./api";
import { renderCardHtml, collectFemaleVariantBaseNames, collectShinyCapableIds, computeFormLabels, compareCards, type SortField } from "./card";
```

Add module state alongside the existing `femaleVariantBaseNames`/`formLabels`/`ownedCards` (currently lines 10-12):

```ts
let femaleVariantBaseNames = new Set<string>();
let formLabels = new Map<string, string>();
let shinyCapableIds = new Set<string>();
let ownedCards: CardView[] = [];
let coins = 0;
```

Modify `renderOwnedGrid` (currently lines 14-28) to pass `coinActions` to `renderCardHtml`:

```ts
function renderOwnedGrid(): void {
  const grid = document.getElementById("owned-grid")!;
  const genValue = (document.getElementById("gen-filter") as HTMLSelectElement).value;
  const nameQuery = (document.getElementById("name-filter") as HTMLInputElement).value.trim().toLowerCase();

  const generation = genValue ? Number(genValue) : null;
  const field = (document.getElementById("sort-field") as HTMLSelectElement).value as SortField;
  const direction = (document.getElementById("sort-direction") as HTMLSelectElement).value;
  const sign = direction === "desc" ? -1 : 1;
  const sorted = ownedCards
    .filter((c) => (generation === null || c.generation === generation))
    .filter((c) => (!nameQuery || c.name.toLowerCase().includes(nameQuery)))
    .sort((a, b) => compareCards(a, b, field) * sign);
  grid.innerHTML = sorted
    .map((c) => renderCardHtml(c, "", femaleVariantBaseNames, formLabels, true, undefined, { coins, shinyCapableIds }))
    .join("");
}
```

Modify `load` (currently lines 131-147) to capture `coins` and `shinyCapableIds` from the response:

```ts
async function load(): Promise<void> {
  const data = await getCollection();
  femaleVariantBaseNames = collectFemaleVariantBaseNames(data.cards);
  formLabels = computeFormLabels(data.cards);
  shinyCapableIds = collectShinyCapableIds(data.cards);
  coins = data.coins;
  ownedCards = data.cards.filter((c) => c.quantity > 0);

  document.getElementById("owned-heading")!.innerHTML =
    `Cromos obtenidos <span class="count">(${ownedCards.length}/${data.cards.length})</span>`;
  renderGenFilterOptions(data.cards);
  renderOwnedGrid();

  renderPendingPacks(data.pendingPacks, async (packId, generation) => {
    const result = await openPack(packId, generation);
    await revealPack(packId, result.cards);
    await load();
  });
}
```

Add event listeners near the bottom of the file, right before `attachTradeLinkButton("trade-link-btn");` (currently line 166):

```ts
function showCoinActionError(message: string): void {
  const el = document.getElementById("coin-action-error")!;
  el.textContent = message;
  el.hidden = false;
}

function clearCoinActionError(): void {
  document.getElementById("coin-action-error")!.hidden = true;
}

document.getElementById("owned-grid")!.addEventListener("card-discard", async (e) => {
  const { cardId } = (e as CustomEvent<{ cardId: string }>).detail;
  clearCoinActionError();
  try {
    const result = await discardCard(cardId);
    coins = result.coins;
    document.dispatchEvent(new CustomEvent("coins-updated", { detail: { coins } }));
    await load();
  } catch (err) {
    showCoinActionError(err instanceof Error ? err.message : "Error al descartar la carta");
  }
});

document.getElementById("owned-grid")!.addEventListener("card-convert-shiny", async (e) => {
  const { cardId } = (e as CustomEvent<{ cardId: string }>).detail;
  clearCoinActionError();
  try {
    const result = await convertToShiny(cardId);
    coins = result.coins;
    document.dispatchEvent(new CustomEvent("coins-updated", { detail: { coins } }));
    await load();
  } catch (err) {
    showCoinActionError(err instanceof Error ? err.message : "Error al convertir la carta");
  }
});
```

- [ ] **Step 4: Type-check and run the full frontend test suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors, all tests PASS.

- [ ] **Step 5: Manual verification in the browser**

Run: `npm run dev`

In the browser (logged in as a viewer with some duplicate cards):
1. Open `/collection.html`, click a card's info button — confirm "Descartar (+N)" appears only when you own more than 1 copy, and the coin value matches the card's rarity from the Global Constraints table.
2. Click "Descartar" — confirm the card's quantity drops by 1, the header coin balance (`#user-coins`) increases, and no page reload was needed.
3. Find a card with quantity >= 2 that has a shiny counterpart — confirm "Convertir a shiny (N)" appears; if your coin balance is below the cost, confirm the button is visibly disabled.
4. With enough coins, click "Convertir a shiny" — confirm it swaps to "¿Seguro? Sí/No" inline, click "No" and confirm it reverts to the button without side effects, then click "Convertir a shiny" again and "Sí" — confirm the normal card's quantity drops by 1, a shiny copy now appears (or its quantity increases) elsewhere in the grid, and the header balance drops by the conversion cost.
5. Try discarding your only copy of a card (quantity 1) — confirm no discard button is shown for it.
6. Force an error (e.g. spam-click convert twice quickly, or discard down to 1 then try again) — confirm `#coin-action-error` shows a readable message instead of a silent failure or a browser alert.

- [ ] **Step 6: Commit**

```bash
git add src/collection.ts collection.html src/style.css
git commit -m "feat: wire discard and shiny-conversion actions into the collection page"
```

## Self-Review Notes

- **Spec coverage:** schema (Task 1), coin values table (Tasks 1/4, verified against Global Constraints in every test), discard rules incl. `reserved` (Task 2), conversion rules incl. `reserved`/already-shiny/no-shiny-pair (Task 3), `getMe`/`GET /collection` exposing balance (Task 1), UI placement inside `.info-tooltip` with inline confirm for conversion (Task 5), header balance display (Task 6), `collection.ts`-only wiring — `trade.ts`/`album.ts`/`overlay.ts` untouched, `renderCardHtml`'s new param is optional so their existing calls are unaffected (Task 5/7). Out-of-scope items from the spec (history log, daily limits, bulk discard, other coin sinks, backfilling missing shiny art) are intentionally not tasked.
- **Type consistency:** `CoinActionsConfig` defined once in `card.ts` (Task 5), consumed as-is in `collection.ts` (Task 7) — no renamed duplicate. `discardCard`/`convertToShiny` return `{ ok: true; coins: number }` consistently from `api.ts` (Task 4) through to their callers (Task 7). `DISCARD_VALUE`/`DISCARD_VALUE_SHINY`/`SHINY_CONVERSION_COST` exist in two files by necessity (`worker/lib/coins.ts` for charging, `src/coins.ts` for display) — both defined with identical literal values in Tasks 1 and 4; a future rebalance must update both (noted here since nothing enforces it automatically, matching how `RARITY_LABELS` in `card.ts` is already an independent frontend copy of worker-side rarity data).
