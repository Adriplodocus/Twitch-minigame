# NEW Badge on Pack Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user opens a pack, every revealed card that is the first copy they've ever owned of that exact card id shows a "NEW" badge.

**Architecture:** The open-pack endpoint (`POST /api/collection/packs/:id/open` in `worker/routes/collection.ts`) queries which of the drawn card ids the user already owned (quantity > 0) *before* inserting the newly drawn copies, then stamps `isNew` on every returned card entry. The frontend (`src/card.ts`'s `renderCardHtml`) renders a small gold badge when `card.isNew` is true; `pack-reveal.ts` needs no changes since it already forwards the full `CardView` object it gets from the API.

**Tech Stack:** Hono + D1 (Workers runtime), vanilla TypeScript, Vitest (`vitest.workers.config.ts` for the backend test, `vitest.config.ts` for the frontend test).

## Global Constraints

- `isNew` is per exact card id (shiny/female/mega/etc. count as distinct cards) — no species-level grouping.
- If a pack grants the same never-before-owned card id more than once, **all** instances in the response get `isNew: true` (one first-time event, not per-copy).
- `isNew` is ephemeral: computed once in the open-pack response, never persisted to D1.
- Out of scope: the OBS overlay (`worker/routes/overlay.ts`, `src/overlay.ts`) does not get the badge.
- Full design context: `docs/superpowers/specs/2026-07-22-new-pack-card-badge-design.md`.

---

### Task 1: Backend — return `isNew` per drawn card from the open-pack endpoint

**Files:**
- Modify: `worker/routes/collection.ts:145-181` (the `POST /packs/:id/open` handler, from `const picked = ...` through `return c.json({ cards, coins: coinsBalance });`)
- Test: `test/routes/collection.test.ts`

**Interfaces:**
- Consumes: nothing new — uses the existing `picked` array (`{ id, rarity, category, sortOrder }[]`) and `user.twitchId` already in scope in this handler.
- Produces: each object in the `cards` array of the JSON response now has an additional `isNew: boolean` field, alongside the existing `id`, `name`, `rarity`, `imagePath`, `sortOrder`, `quantity`.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/collection.test.ts` (place these near the other `/packs/:id/open` tests, e.g. right after `"only draws cards from the requested generation"`):

```typescript
it("flags every card as new the first time a brand-new user opens a pack", async () => {
  await env.DB.prepare("DELETE FROM cards WHERE id = 'r1'").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string; isNew: boolean }[] }>();
  expect(json.cards).toHaveLength(10);
  expect(json.cards.every((c) => c.id === "c1" && c.isNew === true)).toBe(true);
});

it("does not flag a card as new when the user already owns a copy", async () => {
  await env.DB.prepare("DELETE FROM cards WHERE id = 'r1'").run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 1).run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string; isNew: boolean }[] }>();
  expect(json.cards).toHaveLength(10);
  expect(json.cards.every((c) => c.isNew === false)).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/collection.test.ts --config vitest.workers.config.ts -t "new"`
Expected: FAIL — `c.isNew` is `undefined`, so `c.isNew === true` / `c.isNew === false` assertions fail.

- [ ] **Step 3: Implement the backend change**

In `worker/routes/collection.ts`, replace this block:

```typescript
  const picked = pickRandomCards(catalog.results, 10, pack.tier, boost);

  const statements = picked.map((card) =>
    c.env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packId, card.id)
  );
  for (const card of picked) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO user_cards (user_id, card_id, quantity, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP`
      ).bind(user.twitchId, card.id)
    );
  }
  await c.env.DB.batch(statements);

  const uniqueIds = [...new Set(picked.map((card) => card.id))];
  const placeholders = uniqueIds.map(() => "?").join(",");
  const cardDetails = await c.env.DB.prepare(
    `SELECT id, name, rarity, image_path AS imagePath, sort_order AS sortOrder FROM cards WHERE id IN (${placeholders})`
  )
    .bind(...uniqueIds)
    .all<{ id: string; name: string; rarity: Rarity; imagePath: string; sortOrder: number }>();

  const detailsById = new Map(cardDetails.results.map((card) => [card.id, card]));
  const cards = picked.map((card) => ({ ...detailsById.get(card.id)!, quantity: 1 }));
```

with:

```typescript
  const picked = pickRandomCards(catalog.results, 10, pack.tier, boost);
  const uniqueIds = [...new Set(picked.map((card) => card.id))];
  const placeholders = uniqueIds.map(() => "?").join(",");

  const ownedBefore = await c.env.DB.prepare(
    `SELECT card_id AS cardId FROM user_cards WHERE user_id = ? AND card_id IN (${placeholders}) AND quantity > 0`
  )
    .bind(user.twitchId, ...uniqueIds)
    .all<{ cardId: string }>();
  const ownedBeforeIds = new Set(ownedBefore.results.map((row) => row.cardId));

  const statements = picked.map((card) =>
    c.env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packId, card.id)
  );
  for (const card of picked) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO user_cards (user_id, card_id, quantity, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP`
      ).bind(user.twitchId, card.id)
    );
  }
  await c.env.DB.batch(statements);

  const cardDetails = await c.env.DB.prepare(
    `SELECT id, name, rarity, image_path AS imagePath, sort_order AS sortOrder FROM cards WHERE id IN (${placeholders})`
  )
    .bind(...uniqueIds)
    .all<{ id: string; name: string; rarity: Rarity; imagePath: string; sortOrder: number }>();

  const detailsById = new Map(cardDetails.results.map((card) => [card.id, card]));
  const cards = picked.map((card) => ({
    ...detailsById.get(card.id)!,
    quantity: 1,
    isNew: !ownedBeforeIds.has(card.id),
  }));
```

Note the `ownedBefore` query must run (and finish) before `c.env.DB.batch(statements)` executes, since that batch is what changes ownership — the code above already orders it that way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/collection.test.ts --config vitest.workers.config.ts`
Expected: PASS — all tests in the file, including the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add worker/routes/collection.ts test/routes/collection.test.ts
git commit -m "feat: flag first-time cards as new when opening a pack"
```

---

### Task 2: Frontend — render the NEW badge on pack-reveal cards

**Files:**
- Modify: `src/api.ts` (the `CardView` interface)
- Modify: `src/card.ts` (`renderCardHtml`)
- Modify: `src/style.css`
- Test: `src/card.test.ts`

**Interfaces:**
- Consumes: `CardView` (currently in `src/api.ts:5-13`), `renderCardHtml`'s existing signature in `src/card.ts` (`renderCardHtml(card, innerExtra = "", femaleVariantBaseNames?, formLabels?, showQtyBadge = true, footerBadgeHtml?, coinActions?)`) — unchanged, no new parameter needed since the flag rides on `card`.
- Produces: `CardView.isNew?: boolean`. `renderCardHtml` emits `<span class="card-badge-new">✦ New</span>` inside the `.card` element whenever `card.isNew` is truthy.

- [ ] **Step 1: Write the failing tests**

Add to `src/card.test.ts` (near the other basic rendering tests, e.g. after the "owned common non-shiny..." test):

```typescript
it("shows the NEW badge when isNew is true", () => {
  const html = renderCardHtml(card({ isNew: true }));
  expect(html).toContain('class="card-badge-new"');
});

it("does not show the NEW badge when isNew is false or omitted", () => {
  const htmlFalse = renderCardHtml(card({ isNew: false }));
  const htmlOmitted = renderCardHtml(card());
  expect(htmlFalse).not.toContain('class="card-badge-new"');
  expect(htmlOmitted).not.toContain('class="card-badge-new"');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/card.test.ts -t "NEW badge"`
Expected: FAIL — `card({ isNew: true })` errors with a TypeScript type error (`isNew` doesn't exist on `CardView`) until Step 3's type change lands, then (once that compiles) the badge assertion fails because `renderCardHtml` doesn't emit it yet.

- [ ] **Step 3: Implement the frontend change**

In `src/api.ts`, add the field to `CardView` (`src/api.ts:5-13`):

```typescript
export interface CardView {
  id: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
  quantity: number;
  generation: number;
  sortOrder?: number;
  acquiredAt?: string | null;
  isNew?: boolean;
}
```

In `src/card.ts`, inside `renderCardHtml`, add a badge variable next to the other icon variables (right after the `shinyIcon` declaration):

```typescript
  const shinyIcon = isShiny ? `<img class="shiny-icon" src="/shiny-icon.webp" alt="Shiny" />` : "";
  const newBadgeHtml = card.isNew ? `<span class="card-badge-new">✦ New</span>` : "";
```

Then render it inside the returned template, right after `${sparkleHtml}`:

```typescript
  return `
    <div class="card card-rarity-${card.rarity}${vfxClasses} ${ownedClass} card-in">
      ${glareHtml}
      ${sparkleHtml}
      ${newBadgeHtml}
      ${genderIcon}
      ${shinyIcon}
      <img class="card-art" src="${card.imagePath}" alt="${baseName}" loading="lazy" />
```

In `src/style.css`, add this rule right after the `.shiny-icon` rule (`src/style.css:381-388`):

```css
.card-badge-new {
  position: absolute;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--gold);
  color: var(--text-em);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 0.2rem 0.6rem 0.2rem 0.45rem;
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(120, 90, 60, 0.3);
  z-index: 2;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/card.test.ts`
Expected: PASS — all tests in the file, including the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts src/card.ts src/style.css src/card.test.ts
git commit -m "feat: show NEW badge on first-time cards in pack reveal"
```

---

## Manual verification (after both tasks)

1. `npm run dev`
2. Log in, grant/claim a pack (or use an existing pending pack), open it.
3. Confirm any card the account has never owned shows the gold "✦ New" tag centered over the art; cards already owned before this pack don't show it.
4. Confirm it doesn't collide visually with the shiny icon (top-left) or gender icon (top-right) on a shiny/female card that's also new.
