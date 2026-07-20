# Species-fair pack odds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop multi-form species (Unown's 28 forms, Pikachu's cap/event forms) from dominating pack odds and from appearing more than once in the same pack.

**Architecture:** Derive a `speciesKey` from the existing `cards.sort_order` column (`Math.floor(sortOrder / 1_000_000)`, the same formula `src/card.ts:94` already uses for form labels) inside `worker/lib/packs.ts`. Use it to (1) divide each rarity/category/shiny weight budget evenly per **species** instead of per **card row**, and (2) track species already drawn within a single pack call and exclude them from subsequent picks, falling back to allowing a repeat only if a bucket's species pool is fully exhausted mid-pack.

**Tech Stack:** TypeScript, Vitest (`@cloudflare/vitest-pool-workers` / Miniflare), Cloudflare Workers + D1.

## Global Constraints

- No CSV, catalog-build, or migration changes — `sort_order` already exists on every card row (`migrations/0002_card_sort_order.sql:1`, `NOT NULL DEFAULT 0`) and is already trusted for this exact species grouping on the frontend.
- `speciesKey(sortOrder) = Math.floor(sortOrder / 1_000_000)` — must match `src/card.ts:94` exactly.
- No-repeat-species fallback rule: if excluding already-picked species would leave zero candidates for a draw, allow that one draw to repeat a species rather than throwing or degrading rarity.
- Forward-only fix: no changes to `user_cards`, no retroactive dedupe/conversion mechanic, no album (`src/album.ts`) changes.
- Follow existing code style in `worker/lib/packs.ts` (no comments beyond what's already there, same Map-based bucketing approach, same test file conventions).

---

## File Structure

- Modify: `worker/lib/packs.ts` — add `speciesKey`; rewrite `splitShinyWeight`, `buildCardWeights`, `pickRandomCards`, `pickExactCards`.
- Modify: `worker/lib/packs.test.ts` — add `sortOrder` to existing fixtures; add species-fairness and no-repeat tests for `pickRandomCards`.
- Modify: `test/lib/packs.test.ts` — add `sortOrder` to existing fixtures; add a no-repeat test for `pickExactCards`.
- Modify: `worker/routes/collection.ts:51-57` — select `sort_order AS sortOrder`, widen the inline result type.
- Modify: `worker/routes/admin.ts:256-263` — same treatment.

---

### Task 1: Species-fair weights + no-repeat-species in `pickRandomCards`

**Files:**
- Modify: `worker/lib/packs.ts`
- Modify: `worker/lib/packs.test.ts`

**Interfaces:**
- Produces: `export function speciesKey(sortOrder: number): number` — exported from `packs.ts` for reuse by Task 2.
- Produces: `pickRandomCards<T extends { id: string; rarity: Rarity; category: Category; sortOrder: number }>(catalog: T[], count: number, tier: PackTier, random?: () => number): T[]` — same name/shape as today, `sortOrder` added to the constraint.

- [ ] **Step 1: Add `sortOrder` to every existing fixture in `worker/lib/packs.test.ts`**

Replace the whole file's top (interface) and every catalog literal so each already gains a `sortOrder`. Distinct card ids get distinct values (spaced by `1_000_000` so they never collide as the same species); a card and its own `-shiny` counterpart share the same value (mirrors production: `p201`/`p201-shiny` differ by a few units, both floor to the same species).

```ts
import { describe, expect, it } from "vitest";
import { pickRandomCards, RARITY_WEIGHTS_BY_TIER, SHINY_CHANCE_BY_TIER } from "./packs";

interface TestCard {
  id: string;
  rarity: "common" | "rare" | "epic" | "legendary";
  category: "normal" | "inicial" | "mega" | "gmax";
  sortOrder: number;
}
```

Then update each catalog literal in place (values only — ids/rarities/categories unchanged):

```ts
// "picks shiny cards ~1% of the time within a rarity (apoyo tier), uniform among non-shiny"
const catalog: TestCard[] = [
  { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
  { id: "p2", rarity: "common", category: "normal", sortOrder: 2_000_000 },
  { id: "p3", rarity: "common", category: "normal", sortOrder: 3_000_000 },
  { id: "p1-shiny", rarity: "common", category: "normal", sortOrder: 1_000_000 },
];
```

```ts
// "picks shiny cards ~0.5% of the time within a rarity (gratis tier)"
const catalog: TestCard[] = [
  { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
  { id: "p1-shiny", rarity: "common", category: "normal", sortOrder: 1_000_000 },
];
```

```ts
// "gives shiny cards 0% chance if none exist for that rarity"
const catalog: TestCard[] = [
  { id: "p1", rarity: "rare", category: "normal", sortOrder: 1_000_000 },
  { id: "p2", rarity: "rare", category: "normal", sortOrder: 2_000_000 },
];
```

```ts
// "still picks shiny cards if a rarity has only shiny variants"
const catalog: TestCard[] = [{ id: "p1-shiny", rarity: "legendary", category: "normal", sortOrder: 1_000_000 }];
```

```ts
// "respects gratis tier rarity weights (common 71.5 vs legendary 1.5)"
const catalog: TestCard[] = [
  { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
  { id: "p2", rarity: "legendary", category: "normal", sortOrder: 2_000_000 },
];
```

```ts
// "gives legendary a noticeably better chance in apoyo tier than gratis tier"
const catalog: TestCard[] = [
  { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
  { id: "p2", rarity: "legendary", category: "normal", sortOrder: 2_000_000 },
];
```

```ts
// "splits a rarity's weight budget across categories ~89/5/3/3 ..."
const catalog: TestCard[] = [
  { id: "normal1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
  { id: "inicial1", rarity: "common", category: "inicial", sortOrder: 2_000_000 },
  { id: "mega1", rarity: "common", category: "mega", sortOrder: 3_000_000 },
  { id: "gmax1", rarity: "common", category: "gmax", sortOrder: 4_000_000 },
];
```

```ts
// "folds an absent category's weight budget entirely into normal for that rarity"
const catalog: TestCard[] = [
  { id: "normal1", rarity: "rare", category: "normal", sortOrder: 1_000_000 },
  { id: "inicial1", rarity: "rare", category: "inicial", sortOrder: 2_000_000 },
];
```

```ts
// "applies shiny within a non-normal category too"
const catalog: TestCard[] = [
  { id: "mega1", rarity: "epic", category: "mega", sortOrder: 1_000_000 },
  { id: "mega1-shiny", rarity: "epic", category: "mega", sortOrder: 1_000_000 },
];
```

- [ ] **Step 2: Run the suite to confirm it's still green with the unused field added**

Run: `npx vitest run worker/lib/packs.test.ts --config vitest.workers.config.ts`
Expected: all existing tests PASS (the field is inert until Step 3's implementation lands).

- [ ] **Step 3: Write the three new failing tests**

Append inside the existing `describe("pickRandomCards", ...)` block in `worker/lib/packs.test.ts`:

```ts
  it("gives a multi-form species the same total pull chance as a single-form species", () => {
    const catalog: TestCard[] = [
      { id: "unown-a", rarity: "common", category: "normal", sortOrder: 201_000_000 },
      { id: "unown-b", rarity: "common", category: "normal", sortOrder: 201_000_000 },
      { id: "unown-c", rarity: "common", category: "normal", sortOrder: 201_000_000 },
      { id: "unown-d", rarity: "common", category: "normal", sortOrder: 201_000_000 },
      { id: "unown-e", rarity: "common", category: "normal", sortOrder: 201_000_000 },
      { id: "wobbuffet", rarity: "common", category: "normal", sortOrder: 202_000_000 },
    ];
    const rolls = Array.from({ length: 20000 }, (_, i) => i / 20000);
    const picks = pickRandomCards(catalog, rolls.length, "gratis", sequenceRandom(rolls));
    const unownRatio = picks.filter((c) => c.id.startsWith("unown-")).length / picks.length;
    const wobbuffetRatio = picks.filter((c) => c.id === "wobbuffet").length / picks.length;

    expect(unownRatio).toBeGreaterThan(0.45);
    expect(unownRatio).toBeLessThan(0.55);
    expect(wobbuffetRatio).toBeGreaterThan(0.45);
    expect(wobbuffetRatio).toBeLessThan(0.55);
  });

  it("never draws the same species twice within a single pack when enough species exist", () => {
    const catalog: TestCard[] = [
      { id: "a1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "b1", rarity: "common", category: "normal", sortOrder: 2_000_000 },
      { id: "c1", rarity: "common", category: "normal", sortOrder: 3_000_000 },
      { id: "d1", rarity: "common", category: "normal", sortOrder: 4_000_000 },
      { id: "e1", rarity: "common", category: "normal", sortOrder: 5_000_000 },
    ];
    const picks = pickRandomCards(catalog, 5, "gratis", () => 0.999999);
    const speciesSeen = picks.map((c) => Math.floor(c.sortOrder / 1_000_000));
    expect(new Set(speciesSeen).size).toBe(5);
  });

  it("falls back to repeating a species if the pack needs more picks than distinct species exist", () => {
    const catalog: TestCard[] = [
      { id: "unown-a", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "unown-b", rarity: "common", category: "normal", sortOrder: 1_000_000 },
    ];
    const picks = pickRandomCards(catalog, 5, "gratis", () => 0.5);
    expect(picks).toHaveLength(5);
  });
```

- [ ] **Step 4: Run the suite to verify the three new tests fail**

Run: `npx vitest run worker/lib/packs.test.ts --config vitest.workers.config.ts`
Expected: FAIL on the 3 new tests — `"gives a multi-form species..."` fails because `unownRatio` is currently ~0.83 (5/6 of the bucket, one slice per card row) not ~0.5; `"never draws the same species twice..."` fails because today's `pickRandomCards` has no exclusion so `new Set(speciesSeen).size` can be less than 5; `"falls back to repeating..."` currently already passes (no exclusion exists yet) — that's fine, it's a regression guard for Step 5, not a new-behavior assertion.

- [ ] **Step 5: Implement `speciesKey`, species-fair `buildCardWeights`, and exclusion in `pickRandomCards`**

Replace the whole content of `worker/lib/packs.ts` from `export function isShinyCard` down through the end of `pickRandomCards` (i.e. everything except the two `export const ...WEIGHTS...` blocks and the `PackTier` type, which stay unchanged) with:

```ts
export function isShinyCard(id: string): boolean {
  return id.includes("-shiny");
}

export function speciesKey(sortOrder: number): number {
  return Math.floor(sortOrder / 1_000_000);
}

function splitShinyWeight(
  rarityWeight: number,
  shinySpeciesCount: number,
  nonShinySpeciesCount: number,
  shiny: boolean,
  shinyChance: number
): number {
  if (shinySpeciesCount === 0) return shiny ? 0 : rarityWeight / nonShinySpeciesCount;
  if (nonShinySpeciesCount === 0) return shiny ? rarityWeight / shinySpeciesCount : 0;
  return shiny
    ? (rarityWeight * shinyChance) / shinySpeciesCount
    : (rarityWeight * (1 - shinyChance)) / nonShinySpeciesCount;
}

function buildCardWeights<T extends { id: string; rarity: Rarity; category: Category; sortOrder: number }>(
  catalog: T[],
  tier: PackTier
): Map<T, number> {
  const rarityWeights = RARITY_WEIGHTS_BY_TIER[tier];
  const shinyChance = SHINY_CHANCE_BY_TIER[tier];

  // For each (rarity, category) bucket, count how many rows each species
  // contributes, split shiny/non-shiny.
  const bucketsByRarityCategory = new Map<
    Rarity,
    Map<Category, { shinyRows: Map<number, number>; nonShinyRows: Map<number, number> }>
  >();
  for (const card of catalog) {
    let byCategory = bucketsByRarityCategory.get(card.rarity);
    if (!byCategory) {
      byCategory = new Map();
      bucketsByRarityCategory.set(card.rarity, byCategory);
    }
    let bucket = byCategory.get(card.category);
    if (!bucket) {
      bucket = { shinyRows: new Map(), nonShinyRows: new Map() };
      byCategory.set(card.category, bucket);
    }
    const rows = isShinyCard(card.id) ? bucket.shinyRows : bucket.nonShinyRows;
    const species = speciesKey(card.sortOrder);
    rows.set(species, (rows.get(species) ?? 0) + 1);
  }

  const weights = new Map<T, number>();
  for (const [rarity, byCategory] of bucketsByRarityCategory) {
    const rarityWeight = rarityWeights[rarity];

    // Only categories that actually have >=1 card in this rarity reserve their budget;
    // absent categories fold their share entirely into "normal".
    let normalFraction = 1;
    for (const [category, weightFraction] of Object.entries(CATEGORY_WEIGHTS) as [Exclude<Category, "normal">, number][]) {
      if (byCategory.has(category)) normalFraction -= weightFraction;
    }

    for (const [category, bucket] of byCategory) {
      const categoryFraction = category === "normal" ? normalFraction : CATEGORY_WEIGHTS[category];
      const categoryBudget = rarityWeight * categoryFraction;
      const perSpeciesShinyBudget = splitShinyWeight(
        categoryBudget,
        bucket.shinyRows.size,
        bucket.nonShinyRows.size,
        true,
        shinyChance
      );
      const perSpeciesNonShinyBudget = splitShinyWeight(
        categoryBudget,
        bucket.shinyRows.size,
        bucket.nonShinyRows.size,
        false,
        shinyChance
      );

      for (const card of catalog) {
        if (card.rarity !== rarity || card.category !== category) continue;
        const shiny = isShinyCard(card.id);
        const rows = shiny ? bucket.shinyRows : bucket.nonShinyRows;
        const species = speciesKey(card.sortOrder);
        const perSpeciesBudget = shiny ? perSpeciesShinyBudget : perSpeciesNonShinyBudget;
        weights.set(card, perSpeciesBudget / rows.get(species)!);
      }
    }
  }
  return weights;
}

export interface ExactCounts {
  common: number;
  rare: number;
  epic: number;
  legendary: number;
  shiny: number;
}

const NON_SHINY_RARITIES: Rarity[] = ["common", "rare", "epic", "legendary"];

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
    for (let i = 0; i < count; i++) {
      picks.push(pool[Math.floor(random() * pool.length)]);
    }
  }

  if (counts.shiny > 0) {
    const shinyPool = catalog.filter((card) => isShinyCard(card.id));
    if (shinyPool.length === 0) throw new Error("No hay cartas shiny en esta generación");
    for (let i = 0; i < counts.shiny; i++) {
      picks.push(shinyPool[Math.floor(random() * shinyPool.length)]);
    }
  }

  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }

  return picks;
}

export function pickRandomCards<T extends { id: string; rarity: Rarity; category: Category; sortOrder: number }>(
  catalog: T[],
  count: number,
  tier: PackTier,
  random: () => number = Math.random
): T[] {
  if (catalog.length === 0) throw new Error("Catalog is empty");
  const weights = buildCardWeights(catalog, tier);
  const picks: T[] = [];
  const seenSpecies = new Set<number>();

  for (let i = 0; i < count; i++) {
    let pool = catalog.filter((card) => !seenSpecies.has(speciesKey(card.sortOrder)));
    if (pool.length === 0) pool = catalog;

    const totalWeight = pool.reduce((sum, card) => sum + weights.get(card)!, 0);
    let roll = random() * totalWeight;
    let chosen = pool[pool.length - 1];
    for (const card of pool) {
      roll -= weights.get(card)!;
      if (roll <= 0) {
        chosen = card;
        break;
      }
    }
    picks.push(chosen);
    seenSpecies.add(speciesKey(chosen.sortOrder));
  }
  return picks;
}
```

This is a placeholder-free full replacement — note `pickExactCards` is included verbatim (unchanged) here only because it sits between `buildCardWeights` and `pickRandomCards` in the file; Task 2 replaces it again with the exclusion logic. Leaving it byte-for-byte identical to today in this step keeps Task 1 focused on `buildCardWeights`/`pickRandomCards` only.

- [ ] **Step 6: Run the full test file, confirm everything passes**

Run: `npx vitest run worker/lib/packs.test.ts --config vitest.workers.config.ts`
Expected: PASS — all 12 original tests plus the 3 new ones.

- [ ] **Step 7: Commit**

```bash
git add worker/lib/packs.ts worker/lib/packs.test.ts
git commit -m "fix: give multi-form species fair pack odds"
```

---

### Task 2: No-repeat-species in `pickExactCards`

**Files:**
- Modify: `worker/lib/packs.ts`
- Modify: `test/lib/packs.test.ts`

**Interfaces:**
- Consumes: `speciesKey(sortOrder: number): number` from Task 1.
- Produces: `pickExactCards<T extends { id: string; rarity: Rarity; sortOrder: number }>(catalog: T[], counts: ExactCounts, random?: () => number): T[]` — same name/shape as today, `sortOrder` added to the constraint.

- [ ] **Step 1: Add `sortOrder` to every existing fixture in `test/lib/packs.test.ts`**

```ts
import { it, expect } from "vitest";
import { pickRandomCards, pickExactCards, RARITY_WEIGHTS_BY_TIER } from "../../worker/lib/packs";

const catalog = [
  { id: "c1", rarity: "common" as const, category: "normal" as const, sortOrder: 1_000_000 },
  { id: "r1", rarity: "rare" as const, category: "normal" as const, sortOrder: 2_000_000 },
  { id: "e1", rarity: "epic" as const, category: "normal" as const, sortOrder: 3_000_000 },
  { id: "l1", rarity: "legendary" as const, category: "normal" as const, sortOrder: 4_000_000 },
];

const shinyCatalog = [
  { id: "c1", rarity: "common" as const, sortOrder: 1_000_000 },
  { id: "c1-shiny", rarity: "common" as const, sortOrder: 1_000_000 },
  { id: "l1", rarity: "legendary" as const, sortOrder: 4_000_000 },
  { id: "l1-shiny", rarity: "legendary" as const, sortOrder: 4_000_000 },
];
```

And the two single-item catalogs further down in the file:

```ts
// "pickExactCards throws when a requested rarity has no non-shiny cards"
pickExactCards([{ id: "r1-shiny", rarity: "rare" as const, sortOrder: 2_000_000 }], {
  common: 0,
  rare: 1,
  epic: 0,
  legendary: 0,
  shiny: 0,
})
```

```ts
// "pickExactCards throws when shiny is requested but none exist"
pickExactCards([{ id: "c1", rarity: "common" as const, sortOrder: 1_000_000 }], {
  common: 0,
  rare: 0,
  epic: 0,
  legendary: 0,
  shiny: 1,
})
```

- [ ] **Step 2: Run the suite to confirm it's still green**

Run: `npx vitest run test/lib/packs.test.ts --config vitest.workers.config.ts`
Expected: all existing tests PASS.

- [ ] **Step 3: Write the new failing test**

Append at the end of `test/lib/packs.test.ts`:

```ts
it("pickExactCards avoids repeating a species across the whole pack when alternatives exist", () => {
  const twoSpecies = [
    { id: "c1", rarity: "common" as const, sortOrder: 1_000_000 },
    { id: "c2", rarity: "common" as const, sortOrder: 2_000_000 },
  ];
  const picks = pickExactCards(twoSpecies, { common: 2, rare: 0, epic: 0, legendary: 0, shiny: 0 }, () => 0.999999);
  const species = picks.map((c) => Math.floor(c.sortOrder / 1_000_000));
  expect(new Set(species).size).toBe(2);
});
```

- [ ] **Step 4: Run the suite to verify the new test fails**

Run: `npx vitest run test/lib/packs.test.ts --config vitest.workers.config.ts`
Expected: FAIL — today's `pickExactCards` picks independently with replacement, so with `random` pinned at `0.999999` both draws resolve to the same index and `new Set(species).size` is `1`, not `2`.

- [ ] **Step 5: Implement exclusion in `pickExactCards`**

In `worker/lib/packs.ts`, replace the `pickExactCards` function (still on its original `{ id: string; rarity: Rarity }` constraint after Task 1, which only touched `buildCardWeights`/`pickRandomCards`) with:

```ts
export function pickExactCards<T extends { id: string; rarity: Rarity; sortOrder: number }>(
  catalog: T[],
  counts: ExactCounts,
  random: () => number = Math.random
): T[] {
  const picks: T[] = [];
  const seenSpecies = new Set<number>();

  const pickFrom = (pool: T[]): T => {
    let eligible = pool.filter((card) => !seenSpecies.has(speciesKey(card.sortOrder)));
    if (eligible.length === 0) eligible = pool;
    const chosen = eligible[Math.floor(random() * eligible.length)];
    seenSpecies.add(speciesKey(chosen.sortOrder));
    return chosen;
  };

  for (const rarity of NON_SHINY_RARITIES) {
    const count = counts[rarity];
    if (count === 0) continue;
    const pool = catalog.filter((card) => card.rarity === rarity && !isShinyCard(card.id));
    if (pool.length === 0) throw new Error(`No hay cartas ${rarity} no-shiny en esta generación`);
    for (let i = 0; i < count; i++) {
      picks.push(pickFrom(pool));
    }
  }

  if (counts.shiny > 0) {
    const shinyPool = catalog.filter((card) => isShinyCard(card.id));
    if (shinyPool.length === 0) throw new Error("No hay cartas shiny en esta generación");
    for (let i = 0; i < counts.shiny; i++) {
      picks.push(pickFrom(shinyPool));
    }
  }

  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }

  return picks;
}
```

- [ ] **Step 6: Run both packs test files, confirm everything passes**

Run: `npx vitest run test/lib/packs.test.ts worker/lib/packs.test.ts --config vitest.workers.config.ts`
Expected: PASS — all tests in both files.

- [ ] **Step 7: Commit**

```bash
git add worker/lib/packs.ts test/lib/packs.test.ts
git commit -m "fix: prevent pickExactCards from repeating a species per pack"
```

---

### Task 3: Wire `sortOrder` through the real pack-open and admin routes

**Files:**
- Modify: `worker/routes/collection.ts:51-57`
- Modify: `worker/routes/admin.ts:256-263`

**Interfaces:**
- Consumes: `pickRandomCards`/`pickExactCards` from Task 1/2, now requiring `sortOrder: number` on every catalog row passed in.

- [ ] **Step 1: Update the pack-open catalog query in `collection.ts`**

In `worker/routes/collection.ts`, replace:

```ts
  const catalog = await c.env.DB.prepare("SELECT id, rarity, category FROM cards WHERE generation = ?")
    .bind(generation)
    .all<{
      id: string;
      rarity: Rarity;
      category: Category;
    }>();
```

with:

```ts
  const catalog = await c.env.DB.prepare("SELECT id, rarity, category, sort_order AS sortOrder FROM cards WHERE generation = ?")
    .bind(generation)
    .all<{
      id: string;
      rarity: Rarity;
      category: Category;
      sortOrder: number;
    }>();
```

- [ ] **Step 2: Update the same query in `admin.ts`**

In `worker/routes/admin.ts`, replace:

```ts
  const catalog = await c.env.DB.prepare("SELECT id, rarity, category FROM cards WHERE generation = ?")
    .bind(generation)
    .all<{ id: string; rarity: Rarity; category: Category }>();
  if (!catalog.results || catalog.results.length === 0) {
    return c.json({ error: "Catalog is empty" }, 500);
  }

  let picked: { id: string; rarity: Rarity; category: Category }[];
```

with:

```ts
  const catalog = await c.env.DB.prepare("SELECT id, rarity, category, sort_order AS sortOrder FROM cards WHERE generation = ?")
    .bind(generation)
    .all<{ id: string; rarity: Rarity; category: Category; sortOrder: number }>();
  if (!catalog.results || catalog.results.length === 0) {
    return c.json({ error: "Catalog is empty" }, 500);
  }

  let picked: { id: string; rarity: Rarity; category: Category; sortOrder: number }[];
```

- [ ] **Step 3: Typecheck and run the full worker test suite**

Run: `npx tsc --noEmit`
Expected: no errors (confirms every `pickRandomCards`/`pickExactCards` call site now satisfies the `sortOrder` constraint).

Run: `npm run test:worker`
Expected: PASS — including `test/routes/collection.test.ts` and `test/routes/admin.test.ts`, which insert `cards` rows without an explicit `sort_order` (defaults to `0` per `migrations/0002_card_sort_order.sql:1`) and only assert card counts/ids/rarities, not species diversity, so they're unaffected by the new column being selected.

- [ ] **Step 4: Manual spot-check**

Run `npm run dev`, log in as the admin, open the admin panel's test-pack tool, generate a gratis pack for generation 2 a handful of times, and confirm no single pack contains two different Unown forms.

- [ ] **Step 5: Commit**

```bash
git add worker/routes/collection.ts worker/routes/admin.ts
git commit -m "fix: pass sort_order through to pack draw for species fairness"
```

---

## Self-Review Notes

- **Spec coverage:** species-fair weighting → Task 1; no-repeat-species-per-pack for both draw functions → Tasks 1 & 2; callers wired → Task 3. Out-of-scope items (CSV, album, retroactive dupes) confirmed untouched by any task.
- **Placeholder scan:** none — every step has complete code, exact file paths, and exact run commands.
- **Type consistency:** `speciesKey(sortOrder: number): number` used identically in Task 1 and Task 2; `pickRandomCards`/`pickExactCards` signatures match between the plan and their call sites in Task 3.
