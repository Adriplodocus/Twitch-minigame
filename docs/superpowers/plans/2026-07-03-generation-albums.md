# Generation Albums Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single 3154-card album into 9 per-generation albums with a book-style paginated UI (4x4 grid per page, 2 pages per spread, flip animation + sound), and let pack-opening draw from a chosen album's card pool only.

**Architecture:** A new `generation` column on `cards` (schema migration + catalog-build-time computation), read by the client to group cards into 9 albums and by the worker to filter the pack-opening draw pool. `album.html`/`album.ts` become stateful on a `?gen=N` query param: no param shows a 9-album picker, a param shows the paginated book view for that generation. Pack opening gains a generation-choice modal before calling the (now generation-scoped) open endpoint.

**Tech Stack:** TypeScript, Hono (worker), Cloudflare D1, Vite multi-page client, Vitest (`@cloudflare/vitest-pool-workers` for worker/DB tests, node for `tools/`), no client-side test runner (matches existing convention — see Global Constraints).

## Global Constraints

- Full design spec: `docs/superpowers/specs/2026-07-03-generation-albums-design.md` — read it if anything below is ambiguous.
- Generation classification precedence (first match wins): `category === 'mega'` → 6; `category === 'gmax'` → 8; name contains `Alola` → 7; name contains `Galar` → 8; name contains `Hisui` → 8; name contains `Paldea` → 9; else derive from `floor(sortOrder / 1_000_000)` (the real Pokédex number) via ranges `1-151→1, 152-251→2, 252-386→3, 387-493→4, 494-649→5, 650-721→6, 722-809→7, 810-905→8, 906-1025→9`.
- No unit tests for `src/*.ts` client code — the existing codebase has none (e.g. `src/card.ts`'s form-label/name-split logic is untested). Client tasks are verified manually via the dev server. Worker (`worker/`) and catalog tooling (`tools/`) tasks keep full TDD, matching existing `*.test.ts` files there.
- Do not touch `RARITY_WEIGHTS`, `CATEGORY_WEIGHTS`, or `SHINY_CHANCE` in `worker/lib/packs.ts` — pack odds logic is unchanged, only the input catalog is pre-filtered by generation before `pickRandomCards` runs.
- Do not change `collection.html`'s flat "Obtenidas" grid — it stays showing all owned cards across every generation.
- Do not persist which generation a pack was opened for — it's a draw-time-only filter, no `packs` schema change.
- Never run `wrangler d1 migrations apply ... --remote` or `wrangler d1 execute --remote ...` as part of this plan — those are called out explicitly as a separate, manually-confirmed final task (Task 12), consistent with how `docs/superpowers/plans/2026-07-02-pack-category-weights.md` handled the same kind of production rollout.

---

### Task 1: `computeGeneration` in catalog build tooling

**Files:**
- Modify: `tools/catalog/build-catalog.ts`
- Test: `tools/catalog/build-catalog.test.ts`

**Interfaces:**
- Consumes: existing `Category` type and `computeCategory(name: string): Category` from the same file.
- Produces: `export function computeGeneration(name: string, category: Category, sortOrder: number): number` — used by Task 2's `buildCatalog()` wiring.

- [ ] **Step 1: Write the failing tests**

Add to `tools/catalog/build-catalog.test.ts` (append at the end of the file):

```ts
it("computes generation from dex ranges via sortOrder", () => {
  expect(computeGeneration("Bulbasaur", "normal", 1 * 1_000_000)).toBe(1);
  expect(computeGeneration("Ho-Oh", "normal", 250 * 1_000_000)).toBe(2);
  expect(computeGeneration("Absol", "normal", 359 * 1_000_000)).toBe(3);
  expect(computeGeneration("Arceus", "normal", 493 * 1_000_000)).toBe(4);
  expect(computeGeneration("Reshiram", "normal", 643 * 1_000_000)).toBe(5);
  expect(computeGeneration("Xerneas", "normal", 716 * 1_000_000)).toBe(6);
  expect(computeGeneration("Solgaleo", "normal", 791 * 1_000_000)).toBe(7);
  expect(computeGeneration("Zacian", "normal", 888 * 1_000_000)).toBe(8);
  expect(computeGeneration("Koraidon", "normal", 1007 * 1_000_000)).toBe(9);
});

it("handles dex range boundaries", () => {
  expect(computeGeneration("X", "normal", 151 * 1_000_000)).toBe(1);
  expect(computeGeneration("X", "normal", 152 * 1_000_000)).toBe(2);
  expect(computeGeneration("X", "normal", 386 * 1_000_000)).toBe(3);
  expect(computeGeneration("X", "normal", 387 * 1_000_000)).toBe(4);
  expect(computeGeneration("X", "normal", 905 * 1_000_000)).toBe(8);
  expect(computeGeneration("X", "normal", 906 * 1_000_000)).toBe(9);
});

it("overrides generation for mega and gmax categories regardless of base dex", () => {
  expect(computeGeneration("Charizard Mega X", "mega", 6 * 1_000_000)).toBe(6);
  expect(computeGeneration("Pikachu Gmax", "gmax", 25 * 1_000_000)).toBe(8);
});

it("overrides generation for regional-form names regardless of base dex", () => {
  expect(computeGeneration("Vulpix Alola", "normal", 37 * 1_000_000)).toBe(7);
  expect(computeGeneration("Meowth Galar", "normal", 52 * 1_000_000)).toBe(8);
  expect(computeGeneration("Typhlosion Hisui", "normal", 157 * 1_000_000)).toBe(8);
  expect(computeGeneration("Wooper Paldea", "normal", 194 * 1_000_000)).toBe(9);
});
```

Update the import line at the top of the file from:
```ts
import { parseCsv, buildCatalog, computeCategory } from "./build-catalog";
```
to:
```ts
import { parseCsv, buildCatalog, computeCategory, computeGeneration } from "./build-catalog";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.config.ts tools/catalog/build-catalog.test.ts`
Expected: FAIL — `computeGeneration` is not exported / not defined.

- [ ] **Step 3: Implement `computeGeneration`**

In `tools/catalog/build-catalog.ts`, add after the existing `computeCategory` function (after line 31 in the current file):

```ts
const REGIONAL_GENERATION_OVERRIDES: { pattern: RegExp; generation: number }[] = [
  { pattern: /\bAlola\b/, generation: 7 },
  { pattern: /\bGalar\b/, generation: 8 },
  { pattern: /\bHisui\b/, generation: 8 },
  { pattern: /\bPaldea\b/, generation: 9 },
];

const DEX_GENERATION_RANGES: { max: number; generation: number }[] = [
  { max: 151, generation: 1 },
  { max: 251, generation: 2 },
  { max: 386, generation: 3 },
  { max: 493, generation: 4 },
  { max: 649, generation: 5 },
  { max: 721, generation: 6 },
  { max: 809, generation: 7 },
  { max: 905, generation: 8 },
  { max: 1025, generation: 9 },
];

function generationFromDex(dexNumber: number): number {
  for (const range of DEX_GENERATION_RANGES) {
    if (dexNumber <= range.max) return range.generation;
  }
  return 9;
}

export function computeGeneration(name: string, category: Category, sortOrder: number): number {
  if (category === "mega") return 6;
  if (category === "gmax") return 8;
  for (const override of REGIONAL_GENERATION_OVERRIDES) {
    if (override.pattern.test(name)) return override.generation;
  }
  return generationFromDex(Math.floor(sortOrder / 1_000_000));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tools/catalog/build-catalog.test.ts`
Expected: PASS (all tests in the file, including the 4 new ones)

- [ ] **Step 5: Commit**

```bash
git add tools/catalog/build-catalog.ts tools/catalog/build-catalog.test.ts
git commit -m "feat: add computeGeneration for catalog build tooling"
```

---

### Task 2: Wire generation into `CatalogEntry`/seed SQL, add migration, regenerate artifacts

**Files:**
- Modify: `tools/catalog/build-catalog.ts`
- Modify: `tools/catalog/build-catalog.test.ts`
- Create: `migrations/0006_card_generation.sql`
- Regenerate: `catalog.json`, `tools/catalog/seed-cards.sql` (via `npm run catalog:build`)

**Interfaces:**
- Consumes: `computeGeneration` from Task 1.
- Produces: `CatalogEntry.generation: number`; `cards.generation` column in D1 (local); `INSERT OR REPLACE INTO cards (..., generation, ...)` shape in `seed-cards.sql`.

- [ ] **Step 1: Update the existing full-equality test to expect `generation`**

In `tools/catalog/build-catalog.test.ts`, replace the `"builds a catalog and seed SQL from valid rows"` test body:

```ts
it("builds a catalog and seed SQL from valid rows", () => {
  const rows = [
    { id: "c1", name: "Common Card", rarity: "common" as const, imageFilename: "c1.png", sortOrder: 1 },
    { id: "r1", name: "Rare Card", rarity: "rare" as const, imageFilename: "r1.png", sortOrder: 2 },
  ];
  const { catalog, seedSql } = buildCatalog(rows, new Set(["c1.png", "r1.png"]));

  expect(catalog).toEqual([
    {
      id: "c1",
      name: "Common Card",
      rarity: "common",
      category: "normal",
      generation: 1,
      imagePath: "/cards/c1.png",
      sortOrder: 1,
    },
    {
      id: "r1",
      name: "Rare Card",
      rarity: "rare",
      category: "normal",
      generation: 1,
      imagePath: "/cards/r1.png",
      sortOrder: 2,
    },
  ]);
  expect(seedSql).toContain("INSERT OR REPLACE INTO cards");
  expect(seedSql).toContain("'c1'");
  expect(seedSql).toContain("'r1'");
});
```

(`sortOrder` 1 and 2 both floor-divide to dex 0, which `generationFromDex` maps to generation 1 — the first range's upper bound is 151.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts tools/catalog/build-catalog.test.ts`
Expected: FAIL — `catalog` objects are missing the `generation` field.

- [ ] **Step 3: Add `generation` to `CatalogEntry` and wire it into `buildCatalog`**

In `tools/catalog/build-catalog.ts`, update the `CatalogEntry` interface:

```ts
export interface CatalogEntry {
  id: string;
  name: string;
  rarity: Rarity;
  category: Category;
  generation: number;
  imagePath: string;
  sortOrder: number;
}
```

Replace the `catalog.push(...)` block inside `buildCatalog()`:

```ts
    const category = computeCategory(row.name);
    const sortOrder = row.sortOrder ?? 0;
    catalog.push({
      id: row.id,
      name: row.name,
      rarity: row.rarity,
      category,
      generation: computeGeneration(row.name, category, sortOrder),
      imagePath: `/cards/${row.imageFilename}`,
      sortOrder,
    });
```

Replace the seed SQL generation block (the `chunk.map(...)` and the `INSERT OR REPLACE` template):

```ts
    const values = chunk
      .map(
        (card) =>
          `('${card.id}', '${card.name.replace(/'/g, "''")}', '${card.rarity}', '${card.category}', ${card.generation}, '${card.imagePath}', ${card.sortOrder})`
      )
      .join(",\n  ");
    statements.push(
      `INSERT OR REPLACE INTO cards (id, name, rarity, category, generation, image_path, sort_order) VALUES\n  ${values};`
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tools/catalog/build-catalog.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Create the migration**

Create `migrations/0006_card_generation.sql`:

```sql
ALTER TABLE cards ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;

UPDATE cards SET generation = CASE
  WHEN category = 'mega' THEN 6
  WHEN category = 'gmax' THEN 8
  WHEN name LIKE '%Alola%' THEN 7
  WHEN name LIKE '%Galar%' THEN 8
  WHEN name LIKE '%Hisui%' THEN 8
  WHEN name LIKE '%Paldea%' THEN 9
  ELSE CASE
    WHEN sort_order / 1000000 BETWEEN 1 AND 151 THEN 1
    WHEN sort_order / 1000000 BETWEEN 152 AND 251 THEN 2
    WHEN sort_order / 1000000 BETWEEN 252 AND 386 THEN 3
    WHEN sort_order / 1000000 BETWEEN 387 AND 493 THEN 4
    WHEN sort_order / 1000000 BETWEEN 494 AND 649 THEN 5
    WHEN sort_order / 1000000 BETWEEN 650 AND 721 THEN 6
    WHEN sort_order / 1000000 BETWEEN 722 AND 809 THEN 7
    WHEN sort_order / 1000000 BETWEEN 810 AND 905 THEN 8
    ELSE 9
  END
END;

CREATE INDEX idx_cards_generation ON cards(generation);
```

- [ ] **Step 6: Apply the migration locally and regenerate catalog artifacts**

Run: `npx wrangler d1 migrations apply twitch-cards-db --local`
Expected: reports migration `0006_card_generation.sql` applied.

Run: `npm run catalog:build`
Expected: console output `Wrote 3154 cards to .../catalog.json and .../seed-cards.sql` (count matches current catalog size).

Run: `npx wrangler d1 execute twitch-cards-db --local --file=tools/catalog/seed-cards.sql`
Expected: reports rows written, no errors.

- [ ] **Step 7: Spot-check the local D1 data**

Run:
```bash
npx wrangler d1 execute twitch-cards-db --local --command "SELECT id, name, generation FROM cards WHERE id IN ('p1','p10103','p10033','p10195','p10253');"
```
Expected: `p1` (Bulbasaur) → generation 1; `p10103` (Vulpix Alola) → 7; `p10033` (a Mega card) → 6; `p10195` (a Gmax card) → 8; `p10253` (Wooper Paldea) → 9. (If a different row id holds the Mega/Gmax example in your local catalog, run `SELECT id, name FROM cards WHERE category = 'mega' LIMIT 1;` / `... category = 'gmax' ...` first to get real ids — the ones above were the specific ids seen during design research and should still match.)

- [ ] **Step 8: Commit**

```bash
git add tools/catalog/build-catalog.ts tools/catalog/build-catalog.test.ts migrations/0006_card_generation.sql catalog.json tools/catalog/seed-cards.sql
git commit -m "feat: add generation column to card catalog"
```

---

### Task 3: Expose `generation` on `GET /api/collection` and the client `CardView` type

**Files:**
- Modify: `worker/routes/collection.ts`
- Modify: `src/api.ts`
- Test: `test/routes/collection.test.ts`

**Interfaces:**
- Consumes: `cards.generation` column from Task 2.
- Produces: `CardView.generation: number` (consumed by Tasks 8, 9, 10).

- [ ] **Step 1: Write/extend the failing test**

In `test/routes/collection.test.ts`, replace the `"lists all catalog cards with owned quantities and pending packs"` test body:

```ts
it("lists all catalog cards with owned quantities and pending packs", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)")
    .bind("1", "c1", 2)
    .run();
  await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?)").bind("1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/collection", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{
    cards: { id: string; quantity: number; generation: number }[];
    pendingPacks: { id: number }[];
  }>();

  const c1 = json.cards.find((c) => c.id === "c1");
  const r1 = json.cards.find((c) => c.id === "r1");
  expect(c1?.quantity).toBe(2);
  expect(r1?.quantity).toBe(0);
  expect(c1?.generation).toBe(1);
  expect(json.pendingPacks).toHaveLength(1);
});
```

(The `beforeEach` in this file inserts `c1`/`r1` without a `generation` value, so they get the migration's `DEFAULT 1`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts`
Expected: FAIL — `c1?.generation` is `undefined`, not `1`.

- [ ] **Step 3: Add `generation` to the collection query**

In `worker/routes/collection.ts`, update the `GET /` handler's SQL (the `SELECT` inside `collection.get("/", requireAuth, async (c) => { ... })`):

```ts
  const cards = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.rarity, c.image_path AS imagePath, c.sort_order AS sortOrder, c.generation AS generation,
            COALESCE(uc.quantity, 0) AS quantity, uc.updated_at AS acquiredAt
     FROM cards c
     LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = ?
     ORDER BY c.sort_order, c.id`
  )
    .bind(user.twitchId)
    .all();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts`
Expected: PASS

- [ ] **Step 5: Add `generation` to the client `CardView` type**

In `src/api.ts`, update the `CardView` interface:

```ts
export interface CardView {
  id: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
  quantity: number;
  generation: number;
  sortOrder?: number;
  acquiredAt?: string | null;
}
```

- [ ] **Step 6: Commit**

```bash
git add worker/routes/collection.ts src/api.ts test/routes/collection.test.ts
git commit -m "feat: expose card generation on GET /api/collection"
```

---

### Task 4: Filter pack-opening by chosen generation

**Files:**
- Modify: `worker/routes/collection.ts`
- Modify: `src/api.ts`
- Test: `test/routes/collection.test.ts`

**Interfaces:**
- Consumes: `cards.generation` column from Task 2.
- Produces: `openPack(packId: number, generation: number): Promise<{ cards: CardView[] }>` (consumed by Task 10); `POST /api/collection/packs/:id/open` now requires JSON body `{ generation: number }` (1-9) and returns 400 if missing/invalid.

- [ ] **Step 1: Write the failing tests**

In `test/routes/collection.test.ts`, replace the `"opens a pending pack and grants 5 cards"` test (note: the existing test name says "5" but already asserts `toHaveLength(10)` — keep the assertion, just add the body) with:

```ts
it("opens a pending pack and grants 10 cards", async () => {
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
  const json = await res.json<{ cards: { id: string }[] }>();
  expect(json.cards).toHaveLength(10);

  const pack = await env.DB.prepare("SELECT opened_at FROM packs WHERE id = ?")
    .bind(packResult!.id)
    .first<{ opened_at: string | null }>();
  expect(pack?.opened_at).not.toBeNull();
});

it("only draws cards from the requested generation", async () => {
  await env.DB.prepare("UPDATE cards SET generation = 2 WHERE id = 'r1'").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 2 }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string }[] }>();
  expect(json.cards.length).toBeGreaterThan(0);
  expect(json.cards.every((c) => c.id === "r1")).toBe(true);
});

it("rejects opening a pack with an invalid generation", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 99 }),
    },
    env
  );
  expect(res.status).toBe(400);
});
```

Leave `"rejects opening a pack that belongs to another user"` and `"rejects opening an already-opened pack"` exactly as they are (no body needed — see Step 3, ownership/opened-at checks happen before body validation).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts`
Expected: FAIL — the renamed/updated "grants 10 cards" test gets a 400 (no body sent by the old endpoint code path expectations); the two new tests fail because there's no generation filtering or validation yet.

- [ ] **Step 3: Add generation validation and filtering to the open-pack route**

In `worker/routes/collection.ts`, replace the `collection.post("/packs/:id/open", ...)` handler body between the `opened_at` check and the `pickRandomCards` call:

```ts
collection.post("/packs/:id/open", requireAuth, async (c) => {
  const user = c.get("user");
  const packId = Number(c.req.param("id"));

  const pack = await c.env.DB.prepare("SELECT id, user_id, opened_at FROM packs WHERE id = ?")
    .bind(packId)
    .first<{ id: number; user_id: string; opened_at: string | null }>();
  if (!pack || pack.user_id !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (pack.opened_at) return c.json({ error: "Pack already opened" }, 409);

  let body: { generation?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const generation = Number(body.generation);
  if (!Number.isInteger(generation) || generation < 1 || generation > 9) {
    return c.json({ error: "Invalid generation" }, 400);
  }

  const catalog = await c.env.DB.prepare("SELECT id, rarity, category FROM cards WHERE generation = ?")
    .bind(generation)
    .all<{
      id: string;
      rarity: Rarity;
      category: Category;
    }>();
  if (!catalog.results || catalog.results.length === 0) {
    return c.json({ error: "Catalog is empty" }, 500);
  }

  const picked = pickRandomCards(catalog.results, 10);
```

(Everything from `const statements = picked.map(...)` onward in the existing handler stays unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Update the client `openPack` signature**

In `src/api.ts`, replace:

```ts
export function openPack(packId: number): Promise<{ cards: CardView[] }> {
  return request(`/collection/packs/${packId}/open`, { method: "POST" });
}
```

with:

```ts
export function openPack(packId: number, generation: number): Promise<{ cards: CardView[] }> {
  return request(`/collection/packs/${packId}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generation }),
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add worker/routes/collection.ts src/api.ts test/routes/collection.test.ts
git commit -m "feat: filter pack-opening draw pool by chosen generation"
```

---

### Task 5: Shared generation/region metadata

**Files:**
- Create: `src/generations.ts`

**Interfaces:**
- Produces: `export interface GenerationInfo { id: number; region: string }` and `export const GENERATIONS: GenerationInfo[]` (consumed by Tasks 9, 10).

- [ ] **Step 1: Create the file**

```ts
export interface GenerationInfo {
  id: number;
  region: string;
}

export const GENERATIONS: GenerationInfo[] = [
  { id: 1, region: "Kanto" },
  { id: 2, region: "Johto" },
  { id: 3, region: "Hoenn" },
  { id: 4, region: "Sinnoh" },
  { id: 5, region: "Teselia" },
  { id: 6, region: "Kalos" },
  { id: 7, region: "Alola" },
  { id: 8, region: "Galar" },
  { id: 9, region: "Paldea" },
];
```

- [ ] **Step 2: Commit**

```bash
git add src/generations.ts
git commit -m "feat: add shared generation/region metadata"
```

---

### Task 6: Book, album-picker and modal CSS

**Files:**
- Modify: `src/style.css`

**Interfaces:**
- Produces: CSS classes consumed by Tasks 7, 8, 9, 10 — `.album-picker-grid`, `.album-cover`, `.album-cover-gen`, `.album-cover-region`, `.album-cover-count`, `.book-header`, `.book-back-btn`, `.book`, `.book-spread`, `.book-page`, `.book-page-slot-empty`, `.book-spread-flip-out`, `.book-spread-flip-in`, `.book-nav`, `.book-nav-prev`, `.book-nav-next`, `.book-indicator`, `.modal-overlay`, `.modal`, `.modal-gen-grid`, `.modal-gen-btn`, `.modal-cancel-btn`.

- [ ] **Step 1: Append the new styles to `src/style.css`**

```css

.album-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1.25rem;
  margin-top: 1.5rem;
}
.album-cover {
  display: block;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 1.5rem 1rem;
  text-align: center;
  box-shadow: 0 4px 16px rgba(120, 90, 60, 0.10);
  transition: transform 0.18s, box-shadow 0.18s;
}
.album-cover:hover {
  transform: translateY(-4px);
  box-shadow: 0 10px 26px rgba(120, 90, 60, 0.18);
}
.album-cover-gen {
  font-family: 'Russo One', sans-serif;
  font-size: 1.1rem;
  color: var(--text-em);
}
.album-cover-region {
  margin-top: 0.25rem;
  font-size: 0.85rem;
  color: var(--muted);
}
.album-cover-count {
  margin-top: 0.75rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  color: var(--text);
  background: var(--surface2);
  border-radius: 100px;
  padding: 0.3rem 0.8rem;
  display: inline-block;
}

.book-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-top: 2rem;
  flex-wrap: wrap;
}
.book-back-btn { padding: 0.5rem 1.1rem; font-size: 0.8rem; }

.book {
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 0.5rem;
  margin-top: 1.5rem;
  perspective: 1800px;
}
.book-spread {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.5rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 1.25rem;
  box-shadow: 0 10px 30px rgba(120, 90, 60, 0.15);
  transform-style: preserve-3d;
  transform-origin: center;
  will-change: transform, opacity;
}
.book-page {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.6rem;
}
.book-page:first-child {
  border-right: 1px dashed var(--border);
  padding-right: 0.75rem;
}
.book-page:last-child { padding-left: 0.75rem; }
.book-page-slot-empty {
  aspect-ratio: 1;
  border-radius: 14px;
  background: var(--surface2);
  opacity: 0.4;
}
.book-spread-flip-out { animation: book-flip-out 0.24s ease-in forwards; }
.book-spread-flip-in { animation: book-flip-in 0.26s ease-out forwards; }
@keyframes book-flip-out {
  from { transform: rotateY(0deg); opacity: 1; }
  to   { transform: rotateY(-90deg); opacity: 0.3; }
}
@keyframes book-flip-in {
  from { transform: rotateY(90deg); opacity: 0.3; }
  to   { transform: rotateY(0deg); opacity: 1; }
}
.book-nav {
  align-self: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-em);
  font-size: 1.4rem;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(120, 90, 60, 0.12);
  transition: transform 0.15s, box-shadow 0.15s, opacity 0.15s;
}
.book-nav:hover:not(:disabled) { transform: translateY(-2px); }
.book-nav:disabled { opacity: 0.3; cursor: default; }
.book-indicator {
  text-align: center;
  margin-top: 0.75rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  color: var(--muted);
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(59, 46, 34, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 30;
  padding: 1rem;
}
.modal {
  background: var(--surface);
  border-radius: 20px;
  padding: 1.5rem;
  max-width: 420px;
  width: 100%;
  box-shadow: 0 10px 30px rgba(120, 90, 60, 0.25);
  text-align: center;
}
.modal h3 { font-size: 1rem; margin-bottom: 1rem; }
.modal-gen-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.6rem;
}
.modal-gen-btn {
  font-size: 0.75rem;
  padding: 0.6rem 0.5rem;
  background: var(--surface2);
  color: var(--text-em);
  box-shadow: none;
}
.modal-gen-btn:hover { transform: none; box-shadow: 0 4px 12px rgba(120, 90, 60, 0.15); }
.modal-cancel-btn {
  margin-top: 1rem;
  background: transparent;
  color: var(--muted);
  box-shadow: none;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/style.css
git commit -m "feat: add CSS for album picker, book view and generation-picker modal"
```

---

### Task 7: `album.html` markup for picker + book

**Files:**
- Modify: `album.html`

**Interfaces:**
- Produces: DOM element ids consumed by Task 9's `src/album.ts` — `album-picker`, `picker-heading`, `album-picker-grid`, `album-book`, `book-heading`, `book-spread`, `book-prev`, `book-next`, `book-indicator`, `page-flip-sound`.

- [ ] **Step 1: Replace the body content**

Replace the `<body>` contents of `album.html` (currently lines 15-29) with:

```html
  <body>
    <div class="container" style="padding: 2rem 1rem;">
      <h1>Álbum</h1>
      <div style="display: flex; gap: 0.75rem; margin-top: 1rem; flex-wrap: wrap;">
        <a class="btn" href="/collection.html">Volver a Colección</a>
        <button class="btn" id="trade-link-btn" type="button">Copiar enlace de trade</button>
        <a class="btn" href="/offers.html">Ofertas</a>
        <button class="btn" id="logout-btn">Cerrar sesión</button>
      </div>

      <div id="album-picker">
        <h2 id="picker-heading" class="section-heading"></h2>
        <div id="album-picker-grid" class="album-picker-grid"></div>
      </div>

      <div id="album-book" style="display: none;">
        <div class="book-header">
          <a href="/album.html" class="btn book-back-btn">← Álbumes</a>
          <h2 id="book-heading" class="section-heading"></h2>
        </div>
        <div class="book">
          <button type="button" class="book-nav book-nav-prev" id="book-prev" aria-label="Página anterior">‹</button>
          <div class="book-spread" id="book-spread"></div>
          <button type="button" class="book-nav book-nav-next" id="book-next" aria-label="Página siguiente">›</button>
        </div>
        <p class="book-indicator" id="book-indicator"></p>
      </div>
    </div>
    <audio id="page-flip-sound" src="/page-flip.mp3" preload="auto"></audio>
    <script type="module" src="/src/album.ts"></script>
  </body>
```

- [ ] **Step 2: Commit**

```bash
git add album.html
git commit -m "feat: add book/picker markup to album.html"
```

---

### Task 8: Book pagination logic (`src/album-book.ts`)

**Files:**
- Create: `src/album-book.ts`

**Interfaces:**
- Consumes: `CardView` (from `src/api.ts`, Task 3), `renderCardHtml`/`compareCards` (from `src/card.ts`, unchanged).
- Produces: `export const PAGE_SIZE = 16`; `export function pageCount(cardCount: number): number`; `export function cardsForPage<T>(cards: T[], pageIndex: number): (T | null)[]`; `export interface BookDeps { spreadEl: HTMLElement; prevBtn: HTMLButtonElement; nextBtn: HTMLButtonElement; indicatorEl: HTMLElement; flipSound: HTMLAudioElement; femaleVariantBaseNames: Set<string>; formLabels: Map<string, string>; }`; `export class AlbumBook { constructor(cards: CardView[], deps: BookDeps) }` (consumed by Task 9).

- [ ] **Step 1: Create the file**

```ts
import type { CardView } from "./api";
import { renderCardHtml, compareCards } from "./card";

export const PAGE_SIZE = 16;
const PAGES_PER_SPREAD = 2;

export function pageCount(cardCount: number): number {
  const contentPages = Math.max(1, Math.ceil(cardCount / PAGE_SIZE));
  return contentPages % 2 === 0 ? contentPages : contentPages + 1;
}

export function cardsForPage<T>(cards: T[], pageIndex: number): (T | null)[] {
  const start = pageIndex * PAGE_SIZE;
  const slice: (T | null)[] = cards.slice(start, start + PAGE_SIZE);
  while (slice.length < PAGE_SIZE) slice.push(null);
  return slice;
}

export interface BookDeps {
  spreadEl: HTMLElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  indicatorEl: HTMLElement;
  flipSound: HTMLAudioElement;
  femaleVariantBaseNames: Set<string>;
  formLabels: Map<string, string>;
}

const FLIP_OUT_MS = 240;
const FLIP_IN_MS = 260;

export class AlbumBook {
  private readonly cards: CardView[];
  private spreadIndex = 0;
  private readonly totalPages: number;
  private readonly totalSpreads: number;

  constructor(
    cards: CardView[],
    private readonly deps: BookDeps
  ) {
    this.cards = [...cards].sort((a, b) => compareCards(a, b, "pokedex"));
    this.totalPages = pageCount(this.cards.length);
    this.totalSpreads = this.totalPages / PAGES_PER_SPREAD;
    deps.prevBtn.addEventListener("click", () => this.go(-1));
    deps.nextBtn.addEventListener("click", () => this.go(1));
    this.render();
  }

  private renderPageHtml(pageIndex: number): string {
    const slots = cardsForPage(this.cards, pageIndex);
    return `<div class="book-page">${slots
      .map((c) =>
        c
          ? renderCardHtml(c, "", this.deps.femaleVariantBaseNames, this.deps.formLabels)
          : `<div class="book-page-slot-empty"></div>`
      )
      .join("")}</div>`;
  }

  private render(): void {
    const left = this.spreadIndex * PAGES_PER_SPREAD;
    const right = left + 1;
    this.deps.spreadEl.innerHTML = this.renderPageHtml(left) + this.renderPageHtml(right);
    this.deps.prevBtn.disabled = this.spreadIndex === 0;
    this.deps.nextBtn.disabled = this.spreadIndex === this.totalSpreads - 1;
    this.deps.indicatorEl.textContent = `Páginas ${left + 1}–${right + 1} de ${this.totalPages}`;
  }

  private go(direction: -1 | 1): void {
    const nextIndex = this.spreadIndex + direction;
    if (nextIndex < 0 || nextIndex >= this.totalSpreads) return;
    this.spreadIndex = nextIndex;
    this.flipTo();
  }

  private flipTo(): void {
    const spread = this.deps.spreadEl;
    this.deps.flipSound.currentTime = 0;
    this.deps.flipSound.play().catch(() => {});
    spread.classList.add("book-spread-flip-out");
    window.setTimeout(() => {
      this.render();
      spread.classList.remove("book-spread-flip-out");
      spread.classList.add("book-spread-flip-in");
      window.setTimeout(() => spread.classList.remove("book-spread-flip-in"), FLIP_IN_MS);
    }, FLIP_OUT_MS);
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors related to `src/album-book.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/album-book.ts
git commit -m "feat: add book pagination/flip logic for albums"
```

---

### Task 9: Rewrite `src/album.ts` — picker + book routing

**Files:**
- Modify: `src/album.ts`

**Interfaces:**
- Consumes: `GENERATIONS` (Task 5), `AlbumBook` (Task 8), `CardView.generation` (Task 3), DOM ids from Task 7.

- [ ] **Step 1: Replace the file contents**

```ts
import { getCollection, logout, type CardView } from "./api";
import { collectFemaleVariantBaseNames, computeFormLabels } from "./card";
import { attachTradeLinkButton } from "./trade-link";
import { GENERATIONS } from "./generations";
import { AlbumBook } from "./album-book";

function renderPicker(cards: CardView[]): void {
  const owned = cards.filter((c) => c.quantity > 0).length;
  document.getElementById("picker-heading")!.innerHTML =
    `Elige un álbum <span class="count">(${owned}/${cards.length})</span>`;

  const grid = document.getElementById("album-picker-grid")!;
  grid.innerHTML = GENERATIONS.map((gen) => {
    const genCards = cards.filter((c) => c.generation === gen.id);
    const genOwned = genCards.filter((c) => c.quantity > 0).length;
    return `
      <a class="album-cover" href="/album.html?gen=${gen.id}">
        <p class="album-cover-gen">Generación ${gen.id}</p>
        <p class="album-cover-region">${gen.region}</p>
        <span class="album-cover-count">${genOwned}/${genCards.length}</span>
      </a>
    `;
  }).join("");
}

function renderBook(
  cards: CardView[],
  gen: number,
  femaleVariantBaseNames: Set<string>,
  formLabels: Map<string, string>
): void {
  const genInfo = GENERATIONS.find((g) => g.id === gen)!;
  const genCards = cards.filter((c) => c.generation === gen);
  const owned = genCards.filter((c) => c.quantity > 0).length;
  document.getElementById("book-heading")!.innerHTML =
    `Generación ${genInfo.id} · ${genInfo.region} <span class="count">(${owned}/${genCards.length})</span>`;

  new AlbumBook(genCards, {
    spreadEl: document.getElementById("book-spread")!,
    prevBtn: document.getElementById("book-prev") as HTMLButtonElement,
    nextBtn: document.getElementById("book-next") as HTMLButtonElement,
    indicatorEl: document.getElementById("book-indicator")!,
    flipSound: document.getElementById("page-flip-sound") as HTMLAudioElement,
    femaleVariantBaseNames,
    formLabels,
  });
}

function parseGenParam(): number | null {
  const params = new URLSearchParams(window.location.search);
  const gen = Number(params.get("gen"));
  return Number.isInteger(gen) && gen >= 1 && gen <= 9 ? gen : null;
}

async function load(): Promise<void> {
  const data = await getCollection();
  const femaleVariantBaseNames = collectFemaleVariantBaseNames(data.cards);
  const formLabels = computeFormLabels(data.cards);
  const gen = parseGenParam();

  const pickerEl = document.getElementById("album-picker")!;
  const bookEl = document.getElementById("album-book")!;

  if (gen === null) {
    pickerEl.style.display = "";
    bookEl.style.display = "none";
    renderPicker(data.cards);
  } else {
    pickerEl.style.display = "none";
    bookEl.style.display = "";
    renderBook(data.cards, gen, femaleVariantBaseNames, formLabels);
  }
}

document.getElementById("logout-btn")!.addEventListener("click", async () => {
  await logout();
  window.location.href = "/";
});
attachTradeLinkButton("trade-link-btn");

load();
```

- [ ] **Step 2: Manual verification**

Run: `npm run dev`
Then in a browser, log in and go to `/album.html`:
- Confirm the picker shows 9 album covers with region names and an owned/total count each.
- Click a cover, confirm the URL becomes `/album.html?gen=N` and the book view shows with the correct heading, a 4x4/4x4 spread, and working prev/next buttons (prev disabled on the first spread, next disabled on the last).
- Confirm clicking next/prev plays the page-flip sound and shows the rotate transition.
- Confirm the last spread of a generation whose card count isn't a multiple of 32 shows empty placeholder slots, not broken layout.
- Click "← Álbumes" and confirm it returns to the picker.

- [ ] **Step 3: Commit**

```bash
git add src/album.ts
git commit -m "feat: rewrite album.ts to route between generation picker and book view"
```

---

### Task 10: Pack-opening generation picker modal

**Files:**
- Modify: `src/collection.ts`

**Interfaces:**
- Consumes: `GENERATIONS` (Task 5), `openPack(packId, generation)` (Task 4).

- [ ] **Step 1: Add the modal helper and import**

In `src/collection.ts`, add the import:

```ts
import { GENERATIONS } from "./generations";
```

Add this function above `renderPendingPacks`:

```ts
function openAlbumPickerModal(): Promise<number | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <h3>¿De qué álbum quieres abrir el sobre?</h3>
        <div class="modal-gen-grid">
          ${GENERATIONS.map(
            (g) => `<button type="button" class="btn modal-gen-btn" data-gen="${g.id}">Gen ${g.id} · ${g.region}</button>`
          ).join("")}
        </div>
        <button type="button" class="btn modal-cancel-btn">Cancelar</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const genBtn = target.closest<HTMLElement>(".modal-gen-btn");
      if (genBtn) {
        overlay.remove();
        resolve(Number(genBtn.dataset.gen));
        return;
      }
      if (target.closest(".modal-cancel-btn") || target === overlay) {
        overlay.remove();
        resolve(null);
      }
    });
  });
}
```

- [ ] **Step 2: Wire the modal into pack opening**

Replace `renderPendingPacks`'s click handler:

```ts
function renderPendingPacks(packs: PendingPack[], onOpen: (id: number, generation: number) => Promise<void>): void {
  const container = document.getElementById("pending-packs")!;
  if (packs.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `<h2>Sobres pendientes (${packs.length})</h2>`;
  const row = document.createElement("div");
  row.style.cssText = "display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.75rem;";
  container.appendChild(row);

  packs.forEach((pack, index) => {
    const img = document.createElement("img");
    img.className = "pack-open-img";
    img.src = "/pack.webp";
    img.alt = "Abrir sobre";
    img.style.animationDelay = `-${(index * 0.7) % 2.4}s`;
    img.addEventListener("click", async () => {
      const generation = await openAlbumPickerModal();
      if (generation === null) return;
      img.classList.add("opening");
      onOpen(pack.id, generation).finally(() => {
        img.classList.remove("opening");
      });
    });
    row.appendChild(img);
  });
}
```

Replace the call site in `load()`:

```ts
  renderPendingPacks(data.pendingPacks, async (packId, generation) => {
    const result = await openPack(packId, generation);
    await revealPack(result.cards);
    await load();
  });
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev` (if not already running)
With a test account that has a pending pack (see `test/routes/collection.test.ts` for how to insert one directly into local D1, or trigger the real reward flow):
- Go to `/collection.html`, click a pending pack image.
- Confirm a modal appears listing all 9 generations plus a cancel button.
- Click "Cancelar" — confirm the modal closes and nothing else happens (no network call, pack stays pending).
- Click a generation — confirm the modal closes, the pack image dims (`opening` class), the reveal overlay eventually shows 10 cards, and all revealed cards belong to that generation (cross-check names/dex against the chosen generation).

- [ ] **Step 4: Commit**

```bash
git add src/collection.ts
git commit -m "feat: let users choose an album's generation before opening a pack"
```

---

### Task 11: Full end-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test && npm run test:worker`
Expected: all tests pass, including the new/updated ones from Tasks 1, 3, and 4.

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx tsc --noEmit -p tsconfig.worker.json`
Expected: no errors.

- [ ] **Step 3: Full manual pass on the dev server**

Run: `npm run dev`
- Open `/album.html`: verify all 9 albums are reachable, each shows only cards of its own generation, mega/gmax/regional-form cards land in the generation matching their form's introduction (spot-check: a Mega card appears in the Gen 6 album, a Gmax card in Gen 8, an Alolan-form card in Gen 7, a Paldean-form card in Gen 9 — not in their base species' album).
- Flip through every spread of at least 2 albums (including one with a ragged last page) forward and backward; confirm the flip sound and animation fire every time and prev/next disable correctly at the ends.
- Open a pack from `/collection.html`, pick each of a couple of different generations across repeated opens, confirm drawn cards always match the chosen generation.
- Confirm `/collection.html`'s flat "Obtenidas" grid still shows all owned cards from every generation, unchanged.

- [ ] **Step 4: Commit (only if manual verification uncovered fixes)**

If Step 3 required code changes, commit them with a message describing the specific fix (no placeholder text — describe exactly what was wrong and what changed).

---

### Task 12: Production rollout (manual, requires explicit confirmation)

**Files:** none (operational task)

This task mutates the live production database and must not be run without the user's explicit go-ahead at execution time — do not run these commands automatically as part of plan execution.

- [ ] **Step 1: Confirm with the user before running anything in this task.**

- [ ] **Step 2: Apply the migration to production**

Run: `npx wrangler d1 migrations apply twitch-cards-db --remote`
Expected: reports `0006_card_generation.sql` applied (and any other pending migrations).

- [ ] **Step 3: Reseed production with the regenerated catalog**

Run: `npx wrangler d1 execute twitch-cards-db --remote --file=tools/catalog/seed-cards.sql`
Expected: reports rows written, no errors. (Safe to re-run — `INSERT OR REPLACE` keyed by `id`, does not touch `user_cards`/`packs`.)

- [ ] **Step 4: Spot-check production data**

Run:
```bash
npx wrangler d1 execute twitch-cards-db --remote --command "SELECT id, name, generation FROM cards WHERE id IN ('p1','p10103','p10033','p10195','p10253');"
```
Expected: same generation values verified locally in Task 2, Step 7.

- [ ] **Step 5: Deploy the worker + client**

Run: `npm run deploy`
Expected: deploy succeeds; confirm `https://cards.mrklypp.com/album.html` shows the new picker in production.
