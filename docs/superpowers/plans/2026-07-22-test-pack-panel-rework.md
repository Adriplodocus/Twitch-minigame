# Test-Pack Panel Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the admin "Sobre de prueba" panel so shiny counts can be forced per rarity (e.g. legendary shiny), the normal-Common field auto-fills to keep the total at 10, and a "mark as NEW" count is available to preview the NEW badge.

**Architecture:** `ExactCounts` (`worker/lib/packs.ts`) grows from 5 fields (4 rarities + 1 generic shiny) to 8 (4 rarities × normal/shiny), and `pickExactCards` filters the catalog by `rarity` + `isShinyCard` per bucket instead of rarity-only for non-shiny and shiny-only for the old 5th bucket. `POST /api/admin/test-pack` (`worker/routes/admin.ts`) validates the new 8-field shape and accepts an optional `newCount` (0-10) that flags the first N returned cards `isNew: true`. The admin panel UI (`admin.html`, `src/admin.ts`) gets two columns of rarity inputs (Normales/Shiny) instead of 5 flat fields, plus live auto-fill of the normal-Common field and a new NEW-count field.

**Tech Stack:** Hono + D1 (Workers runtime), vanilla TypeScript, Vitest (`vitest.workers.config.ts` for `test/routes/admin.test.ts`, `vitest.config.ts` for `test/lib/packs.test.ts`).

## Global Constraints

- `isNew` marking in the test-pack response is "first N cards of the resolved array", no per-rarity targeting.
- Auto-fill only overwrites the normal-Common field on `input` events from the other 7 fields — never on page load.
- Shiny cards keep the catalog's real `rarity` column (a legendary shiny card has `rarity: "legendary"`) — no schema/catalog change needed, only the filter logic in `pickExactCards`.
- No new frontend unit test file — `src/admin.ts` has no existing test coverage (no `src/admin.test.ts`); verify the UI manually after implementing.
- Full design context: `docs/superpowers/specs/2026-07-22-test-pack-panel-rework-design.md`.

---

### Task 1: Backend — `ExactCounts` grows to 8 rarity×shiny buckets

**Files:**
- Modify: `worker/lib/packs.ts:140-200` (`ExactCounts` interface and `pickExactCards`)
- Test: `test/lib/packs.test.ts`

**Interfaces:**
- Consumes: `isShinyCard` (already exported from this file), `groupBySpecies`/`pickCardBySpecies` (already defined above in this file, unchanged).
- Produces: `ExactCounts` with fields `common, rare, epic, legendary, shinyCommon, shinyRare, shinyEpic, shinyLegendary` (all `number`). `pickExactCards<T extends { id: string; rarity: Rarity; sortOrder: number }>(catalog: T[], counts: ExactCounts, random?: () => number): T[]` — same signature as before, only `ExactCounts`'s shape changed.

- [ ] **Step 1: Write the failing tests**

Replace the existing `pickExactCards` tests in `test/lib/packs.test.ts` (lines 52-87) with:

```typescript
it("pickExactCards returns exactly the requested count per rarity", () => {
  const picks = pickExactCards(shinyCatalog, {
    common: 2,
    rare: 0,
    epic: 0,
    legendary: 1,
    shinyCommon: 0,
    shinyRare: 0,
    shinyEpic: 0,
    shinyLegendary: 0,
  });
  expect(picks.filter((c) => c.rarity === "common")).toHaveLength(2);
  expect(picks.filter((c) => c.rarity === "legendary")).toHaveLength(1);
  expect(picks.every((c) => !c.id.includes("-shiny"))).toBe(true);
});

it("pickExactCards picks shiny cards of the requested rarity only", () => {
  const picks = pickExactCards(
    shinyCatalog,
    { common: 0, rare: 0, epic: 0, legendary: 0, shinyCommon: 0, shinyRare: 0, shinyEpic: 0, shinyLegendary: 3 },
    () => 0.99
  );
  expect(picks).toHaveLength(3);
  expect(picks.every((c) => c.id === "l1-shiny")).toBe(true);
});

it("pickExactCards keeps shiny rarities independent — shinyCommon never returns a legendary shiny", () => {
  const picks = pickExactCards(shinyCatalog, {
    common: 0,
    rare: 0,
    epic: 0,
    legendary: 0,
    shinyCommon: 3,
    shinyRare: 0,
    shinyEpic: 0,
    shinyLegendary: 0,
  });
  expect(picks).toHaveLength(3);
  expect(picks.every((c) => c.id === "c1-shiny")).toBe(true);
});

it("pickExactCards throws when a requested rarity has no non-shiny cards", () => {
  expect(() =>
    pickExactCards([{ id: "r1-shiny", rarity: "rare" as const, sortOrder: 2_000_000 }], {
      common: 0,
      rare: 1,
      epic: 0,
      legendary: 0,
      shinyCommon: 0,
      shinyRare: 0,
      shinyEpic: 0,
      shinyLegendary: 0,
    })
  ).toThrow();
});

it("pickExactCards throws when a requested shiny rarity has no cards", () => {
  expect(() =>
    pickExactCards([{ id: "c1", rarity: "common" as const, sortOrder: 1_000_000 }], {
      common: 0,
      rare: 0,
      epic: 0,
      legendary: 0,
      shinyCommon: 1,
      shinyRare: 0,
      shinyEpic: 0,
      shinyLegendary: 0,
    })
  ).toThrow();
});

it("pickExactCards distributes a rarity's picks evenly across species, not per row", () => {
  const multiFormCatalog = [
    { id: "unown-a", rarity: "common" as const, sortOrder: 201_000_000 },
    { id: "unown-b", rarity: "common" as const, sortOrder: 201_000_000 },
    { id: "unown-c", rarity: "common" as const, sortOrder: 201_000_000 },
    { id: "unown-d", rarity: "common" as const, sortOrder: 201_000_000 },
    { id: "unown-e", rarity: "common" as const, sortOrder: 201_000_000 },
    { id: "wobbuffet", rarity: "common" as const, sortOrder: 202_000_000 },
  ];
  const rolls = Array.from({ length: 20000 }, (_, i) => i / 20000);
  const picks = pickExactCards(
    multiFormCatalog,
    {
      common: 10000,
      rare: 0,
      epic: 0,
      legendary: 0,
      shinyCommon: 0,
      shinyRare: 0,
      shinyEpic: 0,
      shinyLegendary: 0,
    },
    sequenceRandom(rolls)
  );
  const unownRatio = picks.filter((c) => c.id.startsWith("unown-")).length / picks.length;
  const wobbuffetRatio = picks.filter((c) => c.id === "wobbuffet").length / picks.length;

  expect(unownRatio).toBeGreaterThan(0.45);
  expect(unownRatio).toBeLessThan(0.55);
  expect(wobbuffetRatio).toBeGreaterThan(0.45);
  expect(wobbuffetRatio).toBeLessThan(0.55);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/packs.test.ts`
Expected: FAIL — TypeScript errors / assertion failures, since `ExactCounts` still only has `shiny` and `pickExactCards` doesn't know `shinyCommon`/`shinyLegendary`.

- [ ] **Step 3: Implement the backend change**

In `worker/lib/packs.ts`, replace:

```typescript
export interface ExactCounts {
  common: number;
  rare: number;
  epic: number;
  legendary: number;
  shiny: number;
}

const NON_SHINY_RARITIES: Rarity[] = ["common", "rare", "epic", "legendary"];
```

with:

```typescript
export interface ExactCounts {
  common: number;
  rare: number;
  epic: number;
  legendary: number;
  shinyCommon: number;
  shinyRare: number;
  shinyEpic: number;
  shinyLegendary: number;
}

const EXACT_COUNT_BUCKETS: { rarity: Rarity; countKey: keyof ExactCounts; shiny: boolean }[] = [
  { rarity: "common", countKey: "common", shiny: false },
  { rarity: "rare", countKey: "rare", shiny: false },
  { rarity: "epic", countKey: "epic", shiny: false },
  { rarity: "legendary", countKey: "legendary", shiny: false },
  { rarity: "common", countKey: "shinyCommon", shiny: true },
  { rarity: "rare", countKey: "shinyRare", shiny: true },
  { rarity: "epic", countKey: "shinyEpic", shiny: true },
  { rarity: "legendary", countKey: "shinyLegendary", shiny: true },
];
```

Then replace the body of `pickExactCards`:

```typescript
export function pickExactCards<T extends { id: string; rarity: Rarity; sortOrder: number }>(
  catalog: T[],
  counts: ExactCounts,
  random: () => number = Math.random
): T[] {
  const picks: T[] = [];

  for (const rarity of NON_SHINY_RARITIES) {
    const count = counts[rarity];
    if (count === 0) continue;
    const pool = catalog.filter((card) => card.rarity === rarity && !isShinyCard(card.id));
    if (pool.length === 0) throw new Error(`No hay cartas ${rarity} no-shiny en esta generación`);
    const bySpecies = groupBySpecies(pool);
    for (let i = 0; i < count; i++) {
      picks.push(pickCardBySpecies(bySpecies, random));
    }
  }

  if (counts.shiny > 0) {
    const shinyPool = catalog.filter((card) => isShinyCard(card.id));
    if (shinyPool.length === 0) throw new Error("No hay cartas shiny en esta generación");
    const bySpecies = groupBySpecies(shinyPool);
    for (let i = 0; i < counts.shiny; i++) {
      picks.push(pickCardBySpecies(bySpecies, random));
    }
  }

  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }

  return picks;
}
```

with:

```typescript
export function pickExactCards<T extends { id: string; rarity: Rarity; sortOrder: number }>(
  catalog: T[],
  counts: ExactCounts,
  random: () => number = Math.random
): T[] {
  const picks: T[] = [];

  for (const bucket of EXACT_COUNT_BUCKETS) {
    const count = counts[bucket.countKey];
    if (count === 0) continue;
    const pool = catalog.filter((card) => card.rarity === bucket.rarity && isShinyCard(card.id) === bucket.shiny);
    if (pool.length === 0) {
      const label = bucket.shiny ? `${bucket.rarity} shiny` : `${bucket.rarity} no-shiny`;
      throw new Error(`No hay cartas ${label} en esta generación`);
    }
    const bySpecies = groupBySpecies(pool);
    for (let i = 0; i < count; i++) {
      picks.push(pickCardBySpecies(bySpecies, random));
    }
  }

  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }

  return picks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/packs.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add worker/lib/packs.ts test/lib/packs.test.ts
git commit -m "feat: allow forcing shiny counts per rarity in exact-count packs"
```

---

### Task 2: Backend — `POST /api/admin/test-pack` accepts the new counts shape and `newCount`

**Files:**
- Modify: `worker/routes/admin.ts:232-300` (the `/test-pack` handler)
- Test: `test/routes/admin.test.ts`

**Interfaces:**
- Consumes: `ExactCounts` and `pickExactCards` from Task 1 (`worker/lib/packs.ts`).
- Produces: request body now accepts `{ generation, tier, counts?: ExactCounts, newCount?: number }`; response `cards` array entries gain `isNew: boolean`.

- [ ] **Step 1: Write the failing tests**

In `test/routes/admin.test.ts`, replace the body of the `"opens a test pack with an exact forced composition"` test (lines 597-628) — keep the seeded cards as-is, but add a shiny common/epic card and switch the request/assertions to the new shape:

```typescript
it("opens a test pack with an exact forced composition", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES ('__test__', 'Prueba')").run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path, generation) VALUES ('c1', 'Common', 'common', '/c1.png', 1)"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path, generation) VALUES ('r1', 'Rare', 'rare', '/r1.png', 1)"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path, generation) VALUES ('e1', 'Epic', 'epic', '/e1.png', 1)"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path, generation) VALUES ('l1', 'Legendary', 'legendary', '/l1.png', 1)"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path, generation) VALUES ('l1-shiny', 'Legendary Shiny', 'legendary', '/l1s.png', 1)"),
  ]);

  const res = await app.request(
    "/api/admin/test-pack",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await adminCookie() },
      body: JSON.stringify({
        generation: 1,
        tier: "gratis",
        counts: {
          common: 3,
          rare: 2,
          epic: 2,
          legendary: 2,
          shinyCommon: 0,
          shinyRare: 0,
          shinyEpic: 0,
          shinyLegendary: 1,
        },
      }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string; rarity: string }[] }>();
  expect(json.cards).toHaveLength(10);
  expect(json.cards.filter((c) => c.rarity === "common")).toHaveLength(3);
  expect(json.cards.filter((c) => c.rarity === "rare")).toHaveLength(2);
  expect(json.cards.filter((c) => c.rarity === "epic")).toHaveLength(2);
  expect(json.cards.filter((c) => c.id === "l1")).toHaveLength(2);
  expect(json.cards.filter((c) => c.id === "l1-shiny")).toHaveLength(1);
});
```

Replace the `"rejects a test pack with counts that don't sum to 10"` test (lines 630-650) body's `counts` with the 8-field shape:

```typescript
        counts: {
          common: 1,
          rare: 0,
          epic: 0,
          legendary: 0,
          shinyCommon: 0,
          shinyRare: 0,
          shinyEpic: 0,
          shinyLegendary: 0,
        },
```

Replace the `"rejects forced counts requesting a rarity with no cards in that generation"` test (lines 726-746) body's `counts` with:

```typescript
        counts: {
          common: 0,
          rare: 0,
          epic: 0,
          legendary: 10,
          shinyCommon: 0,
          shinyRare: 0,
          shinyEpic: 0,
          shinyLegendary: 0,
        },
```

Add a new test right after the forced-composition test:

```typescript
it("marks the first N cards of a test pack as new", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES ('__test__', 'Prueba')").run();
  await env.DB.prepare(
    "INSERT INTO cards (id, name, rarity, image_path, generation) VALUES ('c1', 'Common', 'common', '/c1.png', 1)"
  ).run();

  const res = await app.request(
    "/api/admin/test-pack",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await adminCookie() },
      body: JSON.stringify({
        generation: 1,
        tier: "gratis",
        counts: {
          common: 10,
          rare: 0,
          epic: 0,
          legendary: 0,
          shinyCommon: 0,
          shinyRare: 0,
          shinyEpic: 0,
          shinyLegendary: 0,
        },
        newCount: 3,
      }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { isNew: boolean }[] }>();
  expect(json.cards.filter((c) => c.isNew)).toHaveLength(3);
  expect(json.cards.filter((c) => !c.isNew)).toHaveLength(7);
});

it("rejects a test pack with an out-of-range newCount", async () => {
  const res = await app.request(
    "/api/admin/test-pack",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await adminCookie() },
      body: JSON.stringify({ generation: 1, tier: "gratis", newCount: 11 }),
    },
    env
  );
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/admin.test.ts --config vitest.workers.config.ts -t "test pack"`
Expected: FAIL — `counts` shape mismatch (old handler still reads `counts.shiny`, which is now `undefined`, so sum validation and shiny picking break), and `newCount`/`isNew` aren't handled yet.

- [ ] **Step 3: Implement the backend change**

In `worker/routes/admin.ts`, replace:

```typescript
admin.post("/test-pack", requireAdmin, async (c) => {
  const body = await c.req
    .json<{ generation?: number; tier?: string; counts?: ExactCounts }>()
    .catch(() => ({}) as { generation?: number; tier?: string; counts?: ExactCounts });
  const { generation, tier, counts } = body;

  if (!Number.isInteger(generation) || generation! < 1 || generation! > 9) {
    return c.json({ error: "Invalid generation" }, 400);
  }
  if (tier !== "gratis" && tier !== "apoyo") {
    return c.json({ error: "Invalid tier" }, 400);
  }

  const countValues = counts ? [counts.common, counts.rare, counts.epic, counts.legendary, counts.shiny] : [];
  const forcingCounts = countValues.some((n) => n > 0);
  if (forcingCounts) {
    if (!countValues.every((n) => Number.isInteger(n) && n >= 0)) {
      return c.json({ error: "Invalid counts" }, 400);
    }
    if (countValues.reduce((a, b) => a + b, 0) !== 10) {
      return c.json({ error: "La suma debe ser 10" }, 400);
    }
  }
```

with:

```typescript
admin.post("/test-pack", requireAdmin, async (c) => {
  const body = await c.req
    .json<{ generation?: number; tier?: string; counts?: ExactCounts; newCount?: number }>()
    .catch(() => ({}) as { generation?: number; tier?: string; counts?: ExactCounts; newCount?: number });
  const { generation, tier, counts, newCount = 0 } = body;

  if (!Number.isInteger(generation) || generation! < 1 || generation! > 9) {
    return c.json({ error: "Invalid generation" }, 400);
  }
  if (tier !== "gratis" && tier !== "apoyo") {
    return c.json({ error: "Invalid tier" }, 400);
  }
  if (!Number.isInteger(newCount) || newCount < 0 || newCount > 10) {
    return c.json({ error: "Invalid newCount" }, 400);
  }

  const countValues = counts
    ? [
        counts.common,
        counts.rare,
        counts.epic,
        counts.legendary,
        counts.shinyCommon,
        counts.shinyRare,
        counts.shinyEpic,
        counts.shinyLegendary,
      ]
    : [];
  const forcingCounts = countValues.some((n) => n > 0);
  if (forcingCounts) {
    if (!countValues.every((n) => Number.isInteger(n) && n >= 0)) {
      return c.json({ error: "Invalid counts" }, 400);
    }
    if (countValues.reduce((a, b) => a + b, 0) !== 10) {
      return c.json({ error: "La suma debe ser 10" }, 400);
    }
  }
```

Then replace the final response-building lines:

```typescript
  const detailsById = new Map(cardDetails.results.map((card) => [card.id, card]));
  const cards = picked.map((card) => ({ ...detailsById.get(card.id)!, quantity: 1 }));

  return c.json({ packId, cards });
```

with:

```typescript
  const detailsById = new Map(cardDetails.results.map((card) => [card.id, card]));
  const cards = picked.map((card, i) => ({
    ...detailsById.get(card.id)!,
    quantity: 1,
    isNew: i < newCount,
  }));

  return c.json({ packId, cards });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/admin.test.ts --config vitest.workers.config.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add worker/routes/admin.ts test/routes/admin.test.ts
git commit -m "feat: support per-rarity shiny counts and a NEW-count preview in test packs"
```

---

### Task 3: Frontend — two-column rarity panel, auto-fill Common, NEW-count field

**Files:**
- Modify: `admin.html:86-104` (the counts row of the "Sobre de prueba" card)
- Modify: `src/admin.ts:287-326` (`readTestPackCounts`, `openTestPack`)
- Modify: `src/style.css` (new `.tp-columns` rule)

**Interfaces:**
- Consumes: `ExactCounts` shape from Task 1/2 (`common, rare, epic, legendary, shinyCommon, shinyRare, shinyEpic, shinyLegendary`); `/test-pack` request body now also takes `newCount`.
- Produces: no new exported functions — this task only rewires DOM ids and the request payload built in `openTestPack`.

- [ ] **Step 1: Replace the counts row markup**

In `admin.html`, replace:

```html
            <div style="margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
              <label style="display: flex; align-items: center; gap: 0.3rem;">Common
                <input type="number" min="0" id="tp-common" value="0" class="input" style="width: 3.5rem;" />
              </label>
              <label style="display: flex; align-items: center; gap: 0.3rem;">Rare
                <input type="number" min="0" id="tp-rare" value="0" class="input" style="width: 3.5rem;" />
              </label>
              <label style="display: flex; align-items: center; gap: 0.3rem;">Epic
                <input type="number" min="0" id="tp-epic" value="0" class="input" style="width: 3.5rem;" />
              </label>
              <label style="display: flex; align-items: center; gap: 0.3rem;">Legendary
                <input type="number" min="0" id="tp-legendary" value="0" class="input" style="width: 3.5rem;" />
              </label>
              <label style="display: flex; align-items: center; gap: 0.3rem;">Shiny
                <input type="number" min="0" id="tp-shiny" value="0" class="input" style="width: 3.5rem;" />
              </label>
            </div>
            <p style="margin-top: 0.4rem; font-size: 0.8rem; color: var(--text);">Déjalo en 0 para probabilidades reales. Si rellenas, debe sumar 10.</p>
            <p id="test-pack-message" style="margin-top: 0.5rem;"></p>
```

with:

```html
            <div class="tp-columns">
              <div class="cfg-column">
                <h3 class="cfg-column-title">Normales</h3>
                <label>
                  <span class="cfg-label-text">Common</span>
                  <input type="number" min="0" id="tp-common" value="0" class="input" />
                </label>
                <label>
                  <span class="cfg-label-text">Rare</span>
                  <input type="number" min="0" id="tp-rare" value="0" class="input" />
                </label>
                <label>
                  <span class="cfg-label-text">Epic</span>
                  <input type="number" min="0" id="tp-epic" value="0" class="input" />
                </label>
                <label>
                  <span class="cfg-label-text">Legendary</span>
                  <input type="number" min="0" id="tp-legendary" value="0" class="input" />
                </label>
              </div>
              <div class="cfg-column">
                <h3 class="cfg-column-title">Shiny</h3>
                <label>
                  <span class="cfg-label-text">Common</span>
                  <input type="number" min="0" id="tp-shiny-common" value="0" class="input" />
                </label>
                <label>
                  <span class="cfg-label-text">Rare</span>
                  <input type="number" min="0" id="tp-shiny-rare" value="0" class="input" />
                </label>
                <label>
                  <span class="cfg-label-text">Epic</span>
                  <input type="number" min="0" id="tp-shiny-epic" value="0" class="input" />
                </label>
                <label>
                  <span class="cfg-label-text">Legendary</span>
                  <input type="number" min="0" id="tp-shiny-legendary" value="0" class="input" />
                </label>
              </div>
            </div>
            <label style="display: flex; align-items: center; gap: 0.3rem; margin-top: 0.75rem;">Marcar como NEW
              <input type="number" min="0" max="10" id="tp-new-count" value="0" class="input" style="width: 3.5rem;" />
            </label>
            <p style="margin-top: 0.4rem; font-size: 0.8rem; color: var(--text);">Déjalo todo en 0 para probabilidades reales. Si rellenas alguna rareza, Common normal se autocompleta para sumar 10.</p>
            <p id="test-pack-message" style="margin-top: 0.5rem;"></p>
```

- [ ] **Step 2: Add the `.tp-columns` CSS rule**

In `src/style.css`, add this rule right after the `.cfg-column { ... }` rule (`src/style.css:80-84`):

```css
.tp-columns {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.25rem;
  margin-top: 0.75rem;
  max-width: 420px;
}
```

- [ ] **Step 3: Rewire `readTestPackCounts` and `openTestPack` in `src/admin.ts`**

Replace:

```typescript
function readTestPackCounts(): { common: number; rare: number; epic: number; legendary: number; shiny: number } {
  const value = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value) || 0;
  return {
    common: value("tp-common"),
    rare: value("tp-rare"),
    epic: value("tp-epic"),
    legendary: value("tp-legendary"),
    shiny: value("tp-shiny"),
  };
}

async function openTestPack(): Promise<void> {
  const messageEl = document.getElementById("test-pack-message")!;
  const generation = Number((document.getElementById("test-pack-generation") as HTMLSelectElement).value);
  const tier = (document.getElementById("test-pack-tier") as HTMLSelectElement).value;
  const counts = readTestPackCounts();
  const forcingCounts = Object.values(counts).some((n) => n > 0);

  const result = await request<{ packId: number; cards: CardView[] }>("/test-pack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(forcingCounts ? { generation, tier, counts } : { generation, tier }),
  });
```

with:

```typescript
function readTestPackCounts(): {
  common: number;
  rare: number;
  epic: number;
  legendary: number;
  shinyCommon: number;
  shinyRare: number;
  shinyEpic: number;
  shinyLegendary: number;
} {
  const value = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value) || 0;
  return {
    common: value("tp-common"),
    rare: value("tp-rare"),
    epic: value("tp-epic"),
    legendary: value("tp-legendary"),
    shinyCommon: value("tp-shiny-common"),
    shinyRare: value("tp-shiny-rare"),
    shinyEpic: value("tp-shiny-epic"),
    shinyLegendary: value("tp-shiny-legendary"),
  };
}

function readTestPackNewCount(): number {
  return Number((document.getElementById("tp-new-count") as HTMLInputElement).value) || 0;
}

function recomputeTestPackCommon(): void {
  const value = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value) || 0;
  const rest =
    value("tp-rare") +
    value("tp-epic") +
    value("tp-legendary") +
    value("tp-shiny-common") +
    value("tp-shiny-rare") +
    value("tp-shiny-epic") +
    value("tp-shiny-legendary");
  (document.getElementById("tp-common") as HTMLInputElement).value = String(Math.max(0, 10 - rest));
}

async function openTestPack(): Promise<void> {
  const messageEl = document.getElementById("test-pack-message")!;
  const generation = Number((document.getElementById("test-pack-generation") as HTMLSelectElement).value);
  const tier = (document.getElementById("test-pack-tier") as HTMLSelectElement).value;
  const counts = readTestPackCounts();
  const newCount = readTestPackNewCount();
  const forcingCounts = Object.values(counts).some((n) => n > 0);

  const result = await request<{ packId: number; cards: CardView[] }>("/test-pack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(forcingCounts ? { generation, tier, counts, newCount } : { generation, tier, newCount }),
  });
```

- [ ] **Step 4: Wire up the auto-fill listeners**

Right after `populateTestPackGenerations();` (`src/admin.ts:498`), add:

```typescript
["tp-rare", "tp-epic", "tp-legendary", "tp-shiny-common", "tp-shiny-rare", "tp-shiny-epic", "tp-shiny-legendary"].forEach(
  (id) => document.getElementById(id)!.addEventListener("input", recomputeTestPackCommon)
);
```

- [ ] **Step 5: Type-check and run the full test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test && npm run test:worker`
Expected: all tests pass (this re-runs Tasks 1 and 2's suites plus everything else, confirming nothing else broke).

- [ ] **Step 6: Manual verification**

1. `npm run dev`, log into `/admin.html`.
2. Set Shiny → Legendary to `1`, confirm Common (normal) auto-fills to `9`.
3. Click "Abrir sobre de prueba" — confirm the pack contains exactly 1 legendary shiny card and 9 normal commons.
4. Set "Marcar como NEW" to `3`, open another test pack — confirm exactly 3 of the 10 revealed cards show the gold NEW badge.
5. Reset all rarity fields to `0` (Common included) and open a pack — confirm it falls back to the real weighted-random draw (not all common).

- [ ] **Step 7: Commit**

```bash
git add admin.html src/admin.ts src/style.css
git commit -m "feat: rework test-pack panel with per-rarity shiny and NEW preview"
```
