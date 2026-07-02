# Pack Category Weights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a category axis (Normal/Inicial/Mega/Gmax) to pack-opening odds and lower shiny chance from 10% to 1%, per `docs/superpowers/specs/2026-07-02-pack-category-weights-design.md`.

**Architecture:** A new `category` column on `cards` (schema migration), computed once at catalog-build time from the card name (starter-species list + Mega/Gmax regex, precedence: inicial > mega > gmax > normal) and persisted via the existing `catalog:build` → `seed-cards.sql` → `wrangler d1 execute` pipeline. `worker/lib/packs.ts`'s weight algorithm is generalized to nest rarity → category → shiny (was rarity → shiny only).

**Tech Stack:** TypeScript, Vitest (`tools/**/*.test.ts` under `vitest.config.ts`; `worker/**/*.test.ts` + `test/**/*.test.ts` under `vitest.workers.config.ts` with `@cloudflare/vitest-pool-workers`, migrations auto-applied from `migrations/` via `readD1Migrations`), Cloudflare D1/Wrangler.

## Global Constraints

- `RARITY_WEIGHTS` in `worker/lib/packs.ts` does NOT change (already `{ common: 70, rare: 15, epic: 10, legendary: 5 }`).
- `SHINY_CHANCE` changes from `0.1` to `0.01`.
- `CATEGORY_WEIGHTS = { inicial: 0.15, mega: 0.10, gmax: 0.10 }`; `normal`'s share is always `1 - sum(CATEGORY_WEIGHTS of categories present in that rarity)` (implicit, never a stored constant for `normal`).
- Categories are mutually exclusive: `normal | inicial | mega | gmax`. Shiny is a separate, orthogonal axis (unchanged `-shiny` id-suffix convention).
- Category precedence (evaluated in this order): starter-species prefix match → `inicial` (wins even over Mega/Gmax name text); else `\bMega\b` → `mega`; else `\bGmax\b` → `gmax`; else `normal`.
- Folding rule: if a category has zero cards within a given rarity, its reserved weight fraction folds entirely into `normal` for that rarity (100% reallocation, not proportional redistribution among remaining specials) — mirrors the existing shiny-count-zero handling already in `packs.ts`.
- No UI changes. No changes to `isShinyCard`, `-female` id-suffix conventions, or `src/card.ts`/`src/style.css`.
- Full starter-species list (81 names, whole-word-prefix match):
  ```
  Bulbasaur, Ivysaur, Venusaur, Charmander, Charmeleon, Charizard, Squirtle, Wartortle, Blastoise,
  Chikorita, Bayleef, Meganium, Cyndaquil, Quilava, Typhlosion, Totodile, Croconaw, Feraligatr,
  Treecko, Grovyle, Sceptile, Torchic, Combusken, Blaziken, Mudkip, Marshtomp, Swampert,
  Turtwig, Grotle, Torterra, Chimchar, Monferno, Infernape, Piplup, Prinplup, Empoleon,
  Snivy, Servine, Serperior, Tepig, Pignite, Emboar, Oshawott, Dewott, Samurott,
  Chespin, Quilladin, Chesnaught, Fennekin, Braixen, Delphox, Froakie, Frogadier, Greninja,
  Rowlet, Dartrix, Decidueye, Litten, Torracat, Incineroar, Popplio, Brionne, Primarina,
  Grookey, Thwackey, Rillaboom, Scorbunny, Raboot, Cinderace, Sobble, Drizzile, Inteleon,
  Sprigatito, Floragato, Meowscarada, Fuecoco, Crocalor, Skeledirge, Quaxly, Quaxwell, Quaquaval
  ```

---

### Task 1: Category computation in catalog build tooling

**Files:**
- Modify: `tools/catalog/build-catalog.ts`
- Test: `tools/catalog/build-catalog.test.ts`

**Interfaces:**
- Consumes: nothing new (existing `CardRow`, `Rarity` types in this file)
- Produces: `export type Category = "normal" | "inicial" | "mega" | "gmax";`, `export function computeCategory(name: string): Category`, and `CatalogEntry` gains `category: Category`. `buildCatalog()`'s returned `seedSql` gains a `category` column/value in every `INSERT OR REPLACE`. These are consumed by Task 2 (migration, no code dependency) and are what gets written to `catalog.json`/`seed-cards.sql` for the production rollout (Task 5).

- [ ] **Step 1: Write failing tests for `computeCategory`**

Add to `tools/catalog/build-catalog.test.ts` (append after the existing tests, keep the existing `import` line and add `computeCategory` to it):

```ts
import { it, expect } from "vitest";
import { parseCsv, buildCatalog, computeCategory } from "./build-catalog";
```

```ts
it("categorizes starter-line species as inicial", () => {
  expect(computeCategory("Bulbasaur")).toBe("inicial");
  expect(computeCategory("Ivysaur")).toBe("inicial");
  expect(computeCategory("Venusaur")).toBe("inicial");
  expect(computeCategory("Venusaur Shiny")).toBe("inicial");
  expect(computeCategory("Venusaur (Hembra)")).toBe("inicial");
});

it("gives inicial precedence over mega/gmax for starter-line species", () => {
  expect(computeCategory("Venusaur Mega")).toBe("inicial");
  expect(computeCategory("Venusaur Mega (Hembra)")).toBe("inicial");
  expect(computeCategory("Venusaur Gmax")).toBe("inicial");
});

it("categorizes non-starter Mega/Gmax cards correctly", () => {
  expect(computeCategory("Alakazam Mega")).toBe("mega");
  expect(computeCategory("Gengar Mega")).toBe("mega");
  expect(computeCategory("Pikachu Gmax")).toBe("gmax");
  expect(computeCategory("Lapras Gmax")).toBe("gmax");
});

it("gives inicial precedence even for a starter's Mega/Gmax forms not caught by the earlier test (Charizard, a starter final evolution)", () => {
  expect(computeCategory("Charizard Mega X")).toBe("inicial");
  expect(computeCategory("Charizard Mega Y")).toBe("inicial");
});

it("does not false-positive-match Meganium as mega (word boundary), but still categorizes it as inicial", () => {
  expect(computeCategory("Meganium")).toBe("inicial");
  expect(computeCategory("Meganium Shiny")).toBe("inicial");
});

it("categorizes everything else as normal", () => {
  expect(computeCategory("Pidgey")).toBe("normal");
  expect(computeCategory("Mewtwo")).toBe("normal");
  expect(computeCategory("Mewtwo Mega X")).toBe("mega");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `computeCategory is not exported` (or similar) from `tools/catalog/build-catalog.test.ts`.

- [ ] **Step 3: Implement `computeCategory` and wire it into `buildCatalog`**

In `tools/catalog/build-catalog.ts`, add near the top (after the existing `VALID_RARITIES` block):

```ts
export type Category = "normal" | "inicial" | "mega" | "gmax";

const STARTER_SPECIES = [
  "Bulbasaur", "Ivysaur", "Venusaur", "Charmander", "Charmeleon", "Charizard", "Squirtle", "Wartortle", "Blastoise",
  "Chikorita", "Bayleef", "Meganium", "Cyndaquil", "Quilava", "Typhlosion", "Totodile", "Croconaw", "Feraligatr",
  "Treecko", "Grovyle", "Sceptile", "Torchic", "Combusken", "Blaziken", "Mudkip", "Marshtomp", "Swampert",
  "Turtwig", "Grotle", "Torterra", "Chimchar", "Monferno", "Infernape", "Piplup", "Prinplup", "Empoleon",
  "Snivy", "Servine", "Serperior", "Tepig", "Pignite", "Emboar", "Oshawott", "Dewott", "Samurott",
  "Chespin", "Quilladin", "Chesnaught", "Fennekin", "Braixen", "Delphox", "Froakie", "Frogadier", "Greninja",
  "Rowlet", "Dartrix", "Decidueye", "Litten", "Torracat", "Incineroar", "Popplio", "Brionne", "Primarina",
  "Grookey", "Thwackey", "Rillaboom", "Scorbunny", "Raboot", "Cinderace", "Sobble", "Drizzile", "Inteleon",
  "Sprigatito", "Floragato", "Meowscarada", "Fuecoco", "Crocalor", "Skeledirge", "Quaxly", "Quaxwell", "Quaquaval",
];

const STARTER_PREFIX_RE = new RegExp(`^(${STARTER_SPECIES.join("|")})\\b`);
const MEGA_RE = /\bMega\b/;
const GMAX_RE = /\bGmax\b/;

export function computeCategory(name: string): Category {
  if (STARTER_PREFIX_RE.test(name)) return "inicial";
  if (MEGA_RE.test(name)) return "mega";
  if (GMAX_RE.test(name)) return "gmax";
  return "normal";
}
```

Then update `CatalogEntry` (add `category: Category` after `rarity: Rarity`):

```ts
export interface CatalogEntry {
  id: string;
  name: string;
  rarity: Rarity;
  category: Category;
  imagePath: string;
  sortOrder: number;
}
```

In `buildCatalog()`, when pushing to `catalog` (inside the `for (const row of rows)` loop), add the `category` field:

```ts
    catalog.push({
      id: row.id,
      name: row.name,
      rarity: row.rarity,
      category: computeCategory(row.name),
      imagePath: `/cards/${row.imageFilename}`,
      sortOrder: row.sortOrder ?? 0,
    });
```

And update the seed SQL generation to include `category`:

```ts
  const CHUNK_SIZE = 200;
  const statements: string[] = [];
  for (let i = 0; i < catalog.length; i += CHUNK_SIZE) {
    const chunk = catalog.slice(i, i + CHUNK_SIZE);
    const values = chunk
      .map(
        (card) =>
          `('${card.id}', '${card.name.replace(/'/g, "''")}', '${card.rarity}', '${card.category}', '${card.imagePath}', ${card.sortOrder})`
      )
      .join(",\n  ");
    statements.push(
      `INSERT OR REPLACE INTO cards (id, name, rarity, category, image_path, sort_order) VALUES\n  ${values};`
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests in `tools/catalog/build-catalog.test.ts` green, including the pre-existing ones (the existing `"builds a catalog and seed SQL from valid rows"` test asserts `catalog` via `toEqual` against a literal that does NOT include `category` — this test WILL now fail because the actual objects have an extra `category` field. Fix that test's expected literals to add `category: "normal"` to each expected catalog entry, since `"Common Card"` and `"Rare Card"` don't match any starter/mega/gmax pattern:

```ts
  expect(catalog).toEqual([
    { id: "c1", name: "Common Card", rarity: "common", category: "normal", imagePath: "/cards/c1.png", sortOrder: 1 },
    { id: "r1", name: "Rare Card", rarity: "rare", category: "normal", imagePath: "/cards/r1.png", sortOrder: 2 },
  ]);
```

Re-run `npm test` after this fix.)

- [ ] **Step 5: Commit**

```bash
git add tools/catalog/build-catalog.ts tools/catalog/build-catalog.test.ts
git commit -m "feat: compute card category (inicial/mega/gmax/normal) in catalog build"
```

---

### Task 2: `category` column migration

**Files:**
- Create: `migrations/0004_card_category.sql`

**Interfaces:**
- Consumes: nothing
- Produces: a `category` column on `cards`, `NOT NULL DEFAULT 'normal'`, `CHECK (category IN ('normal', 'inicial', 'mega', 'gmax'))`. Consumed by Task 3 (weight algorithm reads `card.category`) and Task 4 (`collection.ts` query selects it).

- [ ] **Step 1: Write the migration**

Create `migrations/0004_card_category.sql`:

```sql
ALTER TABLE cards ADD COLUMN category TEXT NOT NULL DEFAULT 'normal'
  CHECK (category IN ('normal', 'inicial', 'mega', 'gmax'));
```

- [ ] **Step 2: Verify existing worker/test suite still passes with the new migration auto-applied**

Run: `npm run test:worker`
Expected: PASS — the test harness (`test/apply-migrations.ts` + `TEST_MIGRATIONS` binding in `vitest.workers.config.ts`) auto-discovers and applies every file in `migrations/`, including the new one. All existing tests (which never insert a `category` value explicitly) should still pass because the column defaults to `'normal'`.

- [ ] **Step 3: Commit**

```bash
git add migrations/0004_card_category.sql
git commit -m "feat: add category column to cards table"
```

---

### Task 3: Generalize weight algorithm to rarity → category → shiny

**Files:**
- Modify: `worker/types.ts`
- Modify: `worker/lib/packs.ts`
- Test: `worker/lib/packs.test.ts`
- Test: `test/lib/packs.test.ts` (type-fix only, see Step 5)

**Interfaces:**
- Consumes: `Category` type shape `"normal" | "inicial" | "mega" | "gmax"` (same string union as Task 1's `tools/catalog/build-catalog.ts` `Category` type, but this is a separate, independently-defined type in `worker/types.ts` — the two files do not import from each other, matching how `Rarity` is already independently defined in both `tools/catalog/build-catalog.ts:5` and `worker/types.ts:14`).
- Produces: `worker/types.ts` exports `Category`. `worker/lib/packs.ts` exports `CATEGORY_WEIGHTS: Record<"inicial" | "mega" | "gmax", number>`, changes `SHINY_CHANCE` to `0.01`, and changes `pickRandomCards`'s generic constraint to `T extends { id: string; rarity: Rarity; category: Category }`. Consumed by Task 4 (`collection.ts` passes catalog rows with a `category` field).

- [ ] **Step 1: Add `Category` type to `worker/types.ts`**

In `worker/types.ts`, after the existing `export type Rarity = ...` line, add:

```ts
export type Category = "normal" | "inicial" | "mega" | "gmax";
```

- [ ] **Step 2: Write failing tests for the new weight behavior**

Replace the full contents of `worker/lib/packs.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { pickRandomCards } from "./packs";

interface TestCard {
  id: string;
  rarity: "common" | "rare" | "epic" | "legendary";
  category: "normal" | "inicial" | "mega" | "gmax";
}

function sequenceRandom(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("pickRandomCards", () => {
  it("throws on an empty catalog", () => {
    expect(() => pickRandomCards([], 1)).toThrow();
  });

  it("picks shiny cards ~1% of the time within a rarity, uniform among non-shiny", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal" },
      { id: "p2", rarity: "common", category: "normal" },
      { id: "p3", rarity: "common", category: "normal" },
      { id: "p1-shiny", rarity: "common", category: "normal" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, sequenceRandom(rolls));
    const shinyCount = picks.filter((c) => c.id === "p1-shiny").length;
    const shinyRatio = shinyCount / picks.length;
    expect(shinyRatio).toBeGreaterThan(0.005);
    expect(shinyRatio).toBeLessThan(0.015);

    const p1 = picks.filter((c) => c.id === "p1").length;
    const p2 = picks.filter((c) => c.id === "p2").length;
    const p3 = picks.filter((c) => c.id === "p3").length;
    expect(p1).toBeCloseTo(p2, -2);
    expect(p2).toBeCloseTo(p3, -2);
  });

  it("gives shiny cards 0% chance if none exist for that rarity", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "rare", category: "normal" },
      { id: "p2", rarity: "rare", category: "normal" },
    ];
    const picks = pickRandomCards(catalog, 100, () => 0.99);
    expect(picks.every((c) => !c.id.includes("-shiny"))).toBe(true);
  });

  it("still picks shiny cards if a rarity has only shiny variants", () => {
    const catalog: TestCard[] = [{ id: "p1-shiny", rarity: "legendary", category: "normal" }];
    const picks = pickRandomCards(catalog, 5, () => 0.5);
    expect(picks.every((c) => c.id === "p1-shiny")).toBe(true);
  });

  it("respects rarity weights across tiers", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal" },
      { id: "p2", rarity: "legendary", category: "normal" },
    ];
    // common weight 70, legendary weight 5 -> common cutoff at roll < 70/75
    const picks = pickRandomCards(catalog, 1, () => 0.5);
    expect(picks[0].id).toBe("p1");

    const legendaryPick = pickRandomCards(catalog, 1, () => 0.99);
    expect(legendaryPick[0].id).toBe("p2");
  });

  it("splits a rarity's weight budget across categories ~65/15/10/10 (normal/inicial/mega/gmax)", () => {
    const catalog: TestCard[] = [
      { id: "normal1", rarity: "common", category: "normal" },
      { id: "inicial1", rarity: "common", category: "inicial" },
      { id: "mega1", rarity: "common", category: "mega" },
      { id: "gmax1", rarity: "common", category: "gmax" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, sequenceRandom(rolls));
    const ratio = (id: string) => picks.filter((c) => c.id === id).length / picks.length;

    expect(ratio("normal1")).toBeGreaterThan(0.63);
    expect(ratio("normal1")).toBeLessThan(0.67);
    expect(ratio("inicial1")).toBeGreaterThan(0.13);
    expect(ratio("inicial1")).toBeLessThan(0.17);
    expect(ratio("mega1")).toBeGreaterThan(0.08);
    expect(ratio("mega1")).toBeLessThan(0.12);
    expect(ratio("gmax1")).toBeGreaterThan(0.08);
    expect(ratio("gmax1")).toBeLessThan(0.12);
  });

  it("folds an absent category's weight budget entirely into normal for that rarity", () => {
    // No "mega" or "gmax" cards exist for "rare" — their 10%+10% should fold into normal, not vanish.
    const catalog: TestCard[] = [
      { id: "normal1", rarity: "rare", category: "normal" },
      { id: "inicial1", rarity: "rare", category: "inicial" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, sequenceRandom(rolls));
    const ratio = (id: string) => picks.filter((c) => c.id === id).length / picks.length;

    // normal should get 100% - 15% (inicial) = 85%, not 65%, since mega/gmax are absent
    expect(ratio("normal1")).toBeGreaterThan(0.83);
    expect(ratio("normal1")).toBeLessThan(0.87);
    expect(ratio("inicial1")).toBeGreaterThan(0.13);
    expect(ratio("inicial1")).toBeLessThan(0.17);
  });

  it("applies shiny ~1% within a non-normal category too", () => {
    const catalog: TestCard[] = [
      { id: "mega1", rarity: "epic", category: "mega" },
      { id: "mega1-shiny", rarity: "epic", category: "mega" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, sequenceRandom(rolls));
    const shinyRatio = picks.filter((c) => c.id === "mega1-shiny").length / picks.length;
    expect(shinyRatio).toBeGreaterThan(0.005);
    expect(shinyRatio).toBeLessThan(0.015);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:worker -- packs.test.ts`
Expected: FAIL — type error (`TestCard` now has `category` but `pickRandomCards`'s current signature only requires `{ id, rarity }`, so this alone wouldn't fail to compile; the actual failures are behavioral: the shiny-ratio test now expects ~1% but current code gives ~10%, and the two new category tests fail because `packs.ts` has no category logic yet).

- [ ] **Step 4: Rewrite `worker/lib/packs.ts`**

Replace the full contents of `worker/lib/packs.ts` with:

```ts
import type { Category, Rarity } from "../types";

export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 70,
  rare: 15,
  epic: 10,
  legendary: 5,
};

export const SHINY_CHANCE = 0.01;

export const CATEGORY_WEIGHTS: Record<Exclude<Category, "normal">, number> = {
  inicial: 0.15,
  mega: 0.1,
  gmax: 0.1,
};

export function isShinyCard(id: string): boolean {
  return id.includes("-shiny");
}

function splitShinyWeight(rarityWeight: number, shinyCount: number, nonShinyCount: number, shiny: boolean): number {
  if (shinyCount === 0) return shiny ? 0 : rarityWeight / nonShinyCount;
  if (nonShinyCount === 0) return shiny ? rarityWeight / shinyCount : 0;
  return shiny ? (rarityWeight * SHINY_CHANCE) / shinyCount : (rarityWeight * (1 - SHINY_CHANCE)) / nonShinyCount;
}

function buildCardWeights<T extends { id: string; rarity: Rarity; category: Category }>(
  catalog: T[]
): Map<T, number> {
  // Count cards per (rarity, category) bucket, split further into shiny/non-shiny.
  const countsByRarityCategory = new Map<Rarity, Map<Category, { shiny: number; nonShiny: number }>>();
  for (const card of catalog) {
    let byCategory = countsByRarityCategory.get(card.rarity);
    if (!byCategory) {
      byCategory = new Map();
      countsByRarityCategory.set(card.rarity, byCategory);
    }
    let counts = byCategory.get(card.category);
    if (!counts) {
      counts = { shiny: 0, nonShiny: 0 };
      byCategory.set(card.category, counts);
    }
    if (isShinyCard(card.id)) counts.shiny++;
    else counts.nonShiny++;
  }

  const weights = new Map<T, number>();
  for (const [rarity, byCategory] of countsByRarityCategory) {
    const rarityWeight = RARITY_WEIGHTS[rarity];

    // Only categories that actually have >=1 card in this rarity reserve their budget;
    // absent categories fold their share entirely into "normal".
    let normalFraction = 1;
    for (const [category, weightFraction] of Object.entries(CATEGORY_WEIGHTS) as [Exclude<Category, "normal">, number][]) {
      if (byCategory.has(category)) normalFraction -= weightFraction;
    }

    for (const [category, counts] of byCategory) {
      const categoryFraction = category === "normal" ? normalFraction : CATEGORY_WEIGHTS[category];
      const categoryBudget = rarityWeight * categoryFraction;

      for (const card of catalog) {
        if (card.rarity !== rarity || card.category !== category) continue;
        const shiny = isShinyCard(card.id);
        weights.set(card, splitShinyWeight(categoryBudget, counts.shiny, counts.nonShiny, shiny));
      }
    }
  }
  return weights;
}

export function pickRandomCards<T extends { id: string; rarity: Rarity; category: Category }>(
  catalog: T[],
  count: number,
  random: () => number = Math.random
): T[] {
  if (catalog.length === 0) throw new Error("Catalog is empty");
  const weights = buildCardWeights(catalog);
  const totalWeight = catalog.reduce((sum, card) => sum + weights.get(card)!, 0);
  const picks: T[] = [];
  for (let i = 0; i < count; i++) {
    let roll = random() * totalWeight;
    let chosen = catalog[catalog.length - 1];
    for (const card of catalog) {
      roll -= weights.get(card)!;
      if (roll <= 0) {
        chosen = card;
        break;
      }
    }
    picks.push(chosen);
  }
  return picks;
}
```

- [ ] **Step 5: Fix `test/lib/packs.test.ts` catalog literals to include `category`**

This file is a second, separate test suite for the same `pickRandomCards` function (also run under `vitest.workers.config.ts` via its `test/**/*.test.ts` include pattern). Its catalog literals need a `category` field now that the generic constraint requires one. Replace its `catalog` constant:

```ts
const catalog = [
  { id: "c1", rarity: "common" as const, category: "normal" as const },
  { id: "r1", rarity: "rare" as const, category: "normal" as const },
  { id: "e1", rarity: "epic" as const, category: "normal" as const },
  { id: "l1", rarity: "legendary" as const, category: "normal" as const },
];
```

No other change needed in this file — none of its assertions depend on category behavior.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:worker -- packs.test.ts`
Expected: PASS — all tests in both `worker/lib/packs.test.ts` and `test/lib/packs.test.ts` green.

- [ ] **Step 7: Commit**

```bash
git add worker/types.ts worker/lib/packs.ts worker/lib/packs.test.ts test/lib/packs.test.ts
git commit -m "feat: weight packs by rarity, category, and shiny (1% shiny, 15/10/10 category split)"
```

---

### Task 4: Wire `category` into the pack-open route

**Files:**
- Modify: `worker/routes/collection.ts:38`

**Interfaces:**
- Consumes: `pickRandomCards` from Task 3 (`worker/lib/packs.ts`, now requires `category` on catalog items), `Category` type from Task 3 (`worker/types.ts`).
- Produces: nothing new for later tasks — this is the final integration point.

- [ ] **Step 1: Update the catalog query and its type**

In `worker/routes/collection.ts`, the import line currently reads:

```ts
import type { Env, Rarity } from "../types";
```

Change it to:

```ts
import type { Category, Env, Rarity } from "../types";
```

Then find this line (inside the `POST /packs/:id/open` handler):

```ts
  const catalog = await c.env.DB.prepare("SELECT id, rarity FROM cards").all<{ id: string; rarity: Rarity }>();
```

Replace with:

```ts
  const catalog = await c.env.DB.prepare("SELECT id, rarity, category FROM cards").all<{
    id: string;
    rarity: Rarity;
    category: Category;
  }>();
```

- [ ] **Step 2: Run the full worker test suite**

Run: `npm run test:worker`
Expected: PASS — `test/routes/collection.test.ts`'s pack-open tests still pass (they don't assert on category, and the test DB's `cards` rows default `category` to `'normal'` per the Task 2 migration's `DEFAULT 'normal'`).

- [ ] **Step 3: Commit**

```bash
git add worker/routes/collection.ts
git commit -m "feat: select card category when opening packs"
```

---

### Task 5: Regenerate catalog and document production rollout

**Files:**
- Modify: (generated, gitignored) `catalog.json`, `tools/catalog/seed-cards.sql` — regenerated, not hand-edited
- No new source files

**Interfaces:**
- Consumes: `computeCategory` from Task 1 (via `npm run catalog:build`), migration from Task 2, `tools/catalog/cards.csv` (existing, unchanged — this task does not modify the CSV).
- Produces: nothing consumed by other tasks — this is the final task, ending in a manual production-rollout step that requires explicit confirmation before running against `--remote`.

- [ ] **Step 1: Regenerate the catalog**

Run: `npm run catalog:build`
Expected output: `Wrote 3155 cards to <path>/catalog.json and <path>/tools/catalog/seed-cards.sql`

- [ ] **Step 2: Spot-check the generated seed SQL for correctness**

Run: `grep "p1'," tools/catalog/seed-cards.sql | head -1` (Bulbasaur — should show `category` value `'inicial'`)
Run: `grep "p10033'," tools/catalog/seed-cards.sql | head -1` (Venusaur Mega — should show `'inicial'`, not `'mega'`, per the inicial-wins-over-mega precedence)
Run: `grep "p10195'," tools/catalog/seed-cards.sql | head -1` (Venusaur Gmax — should show `'inicial'`)
Run: `grep "p154'," tools/catalog/seed-cards.sql | head -1` (Meganium — should show `'inicial'`)
Run: `grep "p10034'," tools/catalog/seed-cards.sql | head -1` (Charizard Mega X — should show `'mega'`, since Charizard is itself a starter-line species... wait: Charizard IS in `STARTER_SPECIES`, so per the precedence rule this ALSO resolves to `'inicial'`, not `'mega'`. Expect `'inicial'`.)
Run: `grep "p10199'," tools/catalog/seed-cards.sql | head -1` (Pikachu Gmax — Pikachu is NOT a starter species, expect `'gmax'`)

If any of these don't match, STOP and report — do not proceed to Step 3 with incorrect category data.

- [ ] **Step 3: Apply the migration and reseed local D1**

Run: `npx wrangler d1 migrations apply twitch-cards-db --local`
Run: `npx wrangler d1 execute twitch-cards-db --local --file=tools/catalog/seed-cards.sql`
Run: `npx wrangler d1 execute twitch-cards-db --local --command "SELECT category, COUNT(*) FROM cards GROUP BY category;"`
Expected: four rows (`normal`, `inicial`, `mega`, `gmax`) with non-zero counts for each (81 starter-line species × their variant rows for `inicial`; the known Mega/Gmax counts minus the starter overlap for `mega`/`gmax`; the rest `normal`).

- [ ] **Step 4: Run the full test suite one more time against the regenerated artifacts**

Run: `npm test && npm run test:worker`
Expected: PASS (this step doesn't depend on `catalog.json`/`seed-cards.sql` since those aren't read by any test, but confirms nothing else regressed before touching production).

- [ ] **Step 5: STOP — do not apply to production without explicit confirmation**

This plan does NOT include running `npx wrangler d1 migrations apply twitch-cards-db --remote` or `npx wrangler d1 execute twitch-cards-db --remote --file=tools/catalog/seed-cards.sql`. Applying schema changes and reseeding 3155 rows against the live production database is a hard-to-reverse action affecting shared state. Report back to the controller/user with the local verification results from Steps 2-4 and let them explicitly decide when to run the two `--remote` commands above.

- [ ] **Step 6: Commit**

`catalog.json` and `tools/catalog/seed-cards.sql` are gitignored (per `.gitignore:5-6`) — there is nothing to commit for this task beyond what Steps 1-4 already verified. If `git status` shows no staged changes, that's correct; skip the commit.

Run: `git status --short`
Expected: no changes related to `catalog.json` or `tools/catalog/seed-cards.sql` shown (they're gitignored) and no other unstaged changes from this task.
