# Catch-Rate-Based Card Rarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace evolution-depth-based card rarity with PokéAPI `capture_rate`, and move the existing Mega/Gmax and Ultra Beast/Paradox rarity floors from one-off `cards.csv` edits into persistent code so they survive future catalog regeneration.

**Architecture:** Two independent pure-function changes (`classifyRarity` in `import-pokemon.ts`, `computeRarityFloor` in `build-catalog.ts`), each unit-tested in isolation, followed by one operational task that regenerates the full card catalog from live PokéAPI data and rolls it out to D1.

**Tech Stack:** TypeScript, Vitest, tsx, PokéAPI (`pokemon-species` endpoint), Cloudflare D1/Wrangler.

## Global Constraints

- Rarity thresholds (exact, from spec): `legendary` = `is_legendary || is_mythical`; `epic` = `capture_rate <= 45`; `rare` = `capture_rate` 46–89; `common` = `capture_rate >= 90`.
- No exception for starters — first-stage starters follow the same capture_rate rule as everything else.
- Mega/Gmax category floor: effective rarity is never below `rare`.
- Named-species legendary floor (exact list): Nihilego, Buzzwole, Pheromosa, Xurkitree, Celesteela, Kartana, Guzzlord, Poipole, Naganadel, Stakataka, Blacephalon, Walking Wake, Iron Leaves, Gouging Fire, Raging Bolt, Iron Boulder, Iron Crown.
- Named-species epic floor (exact list): Great Tusk, Scream Tail, Brute Bonnet, Flutter Mane, Slither Wing, Sandy Shocks, Iron Treads, Iron Bundle, Iron Hands, Iron Jugulis, Iron Moth, Iron Thorns, Roaring Moon, Iron Valiant.
- No schema/migration change — `rarity` CHECK constraint already covers the same 4 values.
- No changes to `RARITY_WEIGHTS` / `CATEGORY_WEIGHTS` in `worker/lib/packs.ts`.
- Retroactive effect is intentional — cards already owned by users must show the new rarity (no snapshot column added).

---

### Task 1: `classifyRarity` — capture-rate-based rarity in `import-pokemon.ts`

**Files:**
- Modify: `tools/catalog/import-pokemon.ts`
- Test: `tools/catalog/import-pokemon.test.ts` (new)

**Interfaces:**
- Produces: `export type Rarity = "common" | "rare" | "epic" | "legendary";`
- Produces: `export function classifyRarity(captureRate: number, isLegendary: boolean, isMythical: boolean): Rarity`

- [ ] **Step 1: Write the failing test**

Create `tools/catalog/import-pokemon.test.ts`:

```ts
import { it, expect } from "vitest";
import { classifyRarity } from "./import-pokemon";

it("classifies legendary/mythical regardless of capture rate", () => {
  expect(classifyRarity(45, true, false)).toBe("legendary");
  expect(classifyRarity(3, false, true)).toBe("legendary");
  expect(classifyRarity(255, true, true)).toBe("legendary");
});

it("classifies epic at capture rate 45 and below", () => {
  expect(classifyRarity(45, false, false)).toBe("epic");
  expect(classifyRarity(25, false, false)).toBe("epic");
  expect(classifyRarity(3, false, false)).toBe("epic");
});

it("classifies rare at capture rate 46 to 89", () => {
  expect(classifyRarity(46, false, false)).toBe("rare");
  expect(classifyRarity(75, false, false)).toBe("rare");
  expect(classifyRarity(89, false, false)).toBe("rare");
});

it("classifies common at capture rate 90 and above", () => {
  expect(classifyRarity(90, false, false)).toBe("common");
  expect(classifyRarity(255, false, false)).toBe("common");
});

it("matches known species thresholds from the design spec", () => {
  expect(classifyRarity(90, false, false)).toBe("common"); // Fearow
  expect(classifyRarity(100, false, false)).toBe("common"); // Kadabra
  expect(classifyRarity(75, false, false)).toBe("rare"); // Raichu
  expect(classifyRarity(50, false, false)).toBe("rare"); // Alakazam (capture_rate 50 falls in the 46-89 rare band)
  expect(classifyRarity(45, false, false)).toBe("epic"); // Dragonite, Gyarados, Tyranitar
  expect(classifyRarity(25, false, false)).toBe("epic"); // Snorlax
  expect(classifyRarity(3, false, false)).toBe("epic"); // Metagross (no legendary flag)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tools/catalog/import-pokemon.test.ts`
Expected: FAIL — `classifyRarity` is not exported from `./import-pokemon` (module has no such export yet).

- [ ] **Step 3: Implement `classifyRarity` and wire it into `getRarity`**

In `tools/catalog/import-pokemon.ts`:

Change line 15 from:
```ts
type Rarity = "common" | "rare" | "epic" | "legendary";
```
to:
```ts
export type Rarity = "common" | "rare" | "epic" | "legendary";
```

Change the `SpeciesInfo` interface (lines 23-29) from:
```ts
interface SpeciesInfo {
  name: string;
  dexNumber: number;
  isLegendary: boolean;
  isMythical: boolean;
  evolvesFrom: string | null;
}
```
to:
```ts
interface SpeciesInfo {
  name: string;
  dexNumber: number;
  isLegendary: boolean;
  isMythical: boolean;
  captureRate: number;
}
```

(`evolvesFrom` is removed — it was only used by the old evolution-depth rarity logic being replaced below, and has no other reader in this file.)

Change `getSpecies` (lines 67-79) from:
```ts
async function getSpecies(cache: Cache, speciesName: string): Promise<SpeciesInfo> {
  if (cache.species[speciesName]) return cache.species[speciesName];
  const data = await fetchJson(`https://pokeapi.co/api/v2/pokemon-species/${speciesName}`);
  const info: SpeciesInfo = {
    name: speciesName,
    dexNumber: data?.id ?? 0,
    isLegendary: !!data?.is_legendary,
    isMythical: !!data?.is_mythical,
    evolvesFrom: data?.evolves_from_species?.name ?? null,
  };
  cache.species[speciesName] = info;
  return info;
}
```
to:
```ts
async function getSpecies(cache: Cache, speciesName: string): Promise<SpeciesInfo> {
  if (cache.species[speciesName]) return cache.species[speciesName];
  const data = await fetchJson(`https://pokeapi.co/api/v2/pokemon-species/${speciesName}`);
  const info: SpeciesInfo = {
    name: speciesName,
    dexNumber: data?.id ?? 0,
    isLegendary: !!data?.is_legendary,
    isMythical: !!data?.is_mythical,
    captureRate: data?.capture_rate ?? 255,
  };
  cache.species[speciesName] = info;
  return info;
}
```

Change `getRarity` (lines 81-90) from:
```ts
async function getRarity(cache: Cache, speciesName: string): Promise<Rarity> {
  const species = await getSpecies(cache, speciesName);
  if (species.isLegendary || species.isMythical) return "legendary";
  if (species.evolvesFrom) {
    const parent = await getSpecies(cache, species.evolvesFrom);
    if (parent.evolvesFrom) return "epic";
    return "rare";
  }
  return "common";
}
```
to:
```ts
export function classifyRarity(captureRate: number, isLegendary: boolean, isMythical: boolean): Rarity {
  if (isLegendary || isMythical) return "legendary";
  if (captureRate <= 45) return "epic";
  if (captureRate <= 89) return "rare";
  return "common";
}

async function getRarity(cache: Cache, speciesName: string): Promise<Rarity> {
  const species = await getSpecies(cache, speciesName);
  return classifyRarity(species.captureRate, species.isLegendary, species.isMythical);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tools/catalog/import-pokemon.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `npm test`
Expected: PASS (all existing suites, including `tools/catalog/build-catalog.test.ts`, unaffected by this change since `import-pokemon.ts` isn't imported by `build-catalog.ts`)

- [ ] **Step 6: Commit**

```bash
git add tools/catalog/import-pokemon.ts tools/catalog/import-pokemon.test.ts
git commit -m "feat: classify card rarity by PokeAPI capture rate"
```

---

### Task 2: `computeRarityFloor` — persistent Mega/Gmax and Ultra Beast/Paradox floors in `build-catalog.ts`

**Files:**
- Modify: `tools/catalog/build-catalog.ts`
- Test: `tools/catalog/build-catalog.test.ts`

**Interfaces:**
- Consumes: `Rarity` type (already exported at line 5 of `build-catalog.ts`), `Category` type (already exported at line 8).
- Produces: `export function computeRarityFloor(name: string, category: Category, rarity: Rarity): Rarity`

- [ ] **Step 1: Write the failing tests**

Add to `tools/catalog/build-catalog.test.ts` (append after the existing `computeGeneration` tests, and add `computeRarityFloor` to the import on line 2):

Change line 2 from:
```ts
import { parseCsv, buildCatalog, computeCategory, computeGeneration } from "./build-catalog";
```
to:
```ts
import { parseCsv, buildCatalog, computeCategory, computeGeneration, computeRarityFloor } from "./build-catalog";
```

Append:
```ts
it("floors mega/gmax cards to at least rare", () => {
  expect(computeRarityFloor("Meowth Gmax", "gmax", "common")).toBe("rare");
  expect(computeRarityFloor("Gengar Mega", "mega", "common")).toBe("rare");
});

it("does not lower a mega/gmax card that is already above the rare floor", () => {
  expect(computeRarityFloor("Gengar Mega", "mega", "epic")).toBe("epic");
  expect(computeRarityFloor("Gengar Mega", "mega", "legendary")).toBe("legendary");
});

it("does not floor normal-category cards", () => {
  expect(computeRarityFloor("Meowth", "normal", "common")).toBe("common");
});

it("floors named legendary-tier Ultra Beasts and Paradox species to legendary", () => {
  expect(computeRarityFloor("Nihilego", "normal", "common")).toBe("legendary");
  expect(computeRarityFloor("Buzzwole", "normal", "rare")).toBe("legendary");
  expect(computeRarityFloor("Walking Wake", "normal", "epic")).toBe("legendary");
  expect(computeRarityFloor("Raging Bolt", "normal", "common")).toBe("legendary");
});

it("floors named epic-tier Paradox species to epic", () => {
  expect(computeRarityFloor("Great Tusk", "normal", "common")).toBe("epic");
  expect(computeRarityFloor("Iron Valiant", "normal", "rare")).toBe("epic");
});

it("matches named-species floors on shiny/female name suffixes via word-boundary prefix", () => {
  expect(computeRarityFloor("Nihilego Shiny", "normal", "common")).toBe("legendary");
  expect(computeRarityFloor("Great Tusk Shiny", "normal", "common")).toBe("epic");
});

it("does not lower a named-species card that is already above its floor", () => {
  expect(computeRarityFloor("Nihilego", "normal", "legendary")).toBe("legendary");
  expect(computeRarityFloor("Great Tusk", "normal", "legendary")).toBe("legendary");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tools/catalog/build-catalog.test.ts`
Expected: FAIL — `computeRarityFloor` is not exported from `./build-catalog`.

- [ ] **Step 3: Implement `computeRarityFloor`**

In `tools/catalog/build-catalog.ts`, insert immediately after the `computeCategory` function (after line 31, before line 33's `REGIONAL_GENERATION_OVERRIDES`):

```ts
const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };

function floorRarity(rarity: Rarity, floor: Rarity): Rarity {
  return RARITY_RANK[floor] > RARITY_RANK[rarity] ? floor : rarity;
}

const LEGENDARY_FLOOR_SPECIES = [
  "Nihilego", "Buzzwole", "Pheromosa", "Xurkitree", "Celesteela", "Kartana", "Guzzlord",
  "Poipole", "Naganadel", "Stakataka", "Blacephalon",
  "Walking Wake", "Iron Leaves", "Gouging Fire", "Raging Bolt", "Iron Boulder", "Iron Crown",
];

const EPIC_FLOOR_SPECIES = [
  "Great Tusk", "Scream Tail", "Brute Bonnet", "Flutter Mane", "Slither Wing", "Sandy Shocks",
  "Iron Treads", "Iron Bundle", "Iron Hands", "Iron Jugulis", "Iron Moth", "Iron Thorns",
  "Roaring Moon", "Iron Valiant",
];

const LEGENDARY_FLOOR_RE = new RegExp(`^(${LEGENDARY_FLOOR_SPECIES.join("|")})\\b`);
const EPIC_FLOOR_RE = new RegExp(`^(${EPIC_FLOOR_SPECIES.join("|")})\\b`);

export function computeRarityFloor(name: string, category: Category, rarity: Rarity): Rarity {
  let floored = rarity;
  if (category === "mega" || category === "gmax") floored = floorRarity(floored, "rare");
  if (LEGENDARY_FLOOR_RE.test(name)) floored = floorRarity(floored, "legendary");
  else if (EPIC_FLOOR_RE.test(name)) floored = floorRarity(floored, "epic");
  return floored;
}
```

Then, in `buildCatalog()`, change (lines 124-134) from:
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
to:
```ts
    const category = computeCategory(row.name);
    const sortOrder = row.sortOrder ?? 0;
    const rarity = computeRarityFloor(row.name, category, row.rarity);
    catalog.push({
      id: row.id,
      name: row.name,
      rarity,
      category,
      generation: computeGeneration(row.name, category, sortOrder),
      imagePath: `/cards/${row.imageFilename}`,
      sortOrder,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tools/catalog/build-catalog.test.ts`
Expected: PASS (all tests, including the 8 new ones)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tools/catalog/build-catalog.ts tools/catalog/build-catalog.test.ts
git commit -m "feat: floor mega/gmax and ultra beast/paradox rarity in build-catalog"
```

---

### Task 3: Regenerate the catalog and roll out to D1

**Files:**
- Modify (generated, not hand-edited): `tools/catalog/cards.csv`, `catalog.json`, `tools/catalog/seed-cards.sql`
- Delete (local-only, gitignored): `tools/catalog/.pokeapi-cache.json`

**Interfaces:**
- Consumes: `classifyRarity` (Task 1) via `import-pokemon.ts`'s `main()`; `computeRarityFloor` (Task 2) via `build-catalog.ts`'s `main()`. No new interfaces produced — this task is operational, not code.

This task must run after Task 1 and Task 2 are both committed, since it exercises `main()` in both scripts end-to-end against live PokéAPI data.

- [ ] **Step 1: Delete the stale PokéAPI cache**

`tools/catalog/.pokeapi-cache.json` caches fetched species data keyed by name, including the old `evolvesFrom` field and no `captureRate` field. Since it's gitignored and purely a local speed-up cache, delete it so every species gets re-fetched with the new `capture_rate` field:

```bash
rm -f tools/catalog/.pokeapi-cache.json
```

- [ ] **Step 2: Run the import script to regenerate `cards.csv`**

Requires network access to `pokeapi.co` and the `SPRITE_ROOT` sprite directory (defaults to `C:/Proyectos/SpritesPokemon/sprites/pokemon`; override via `SPRITE_ROOT` env var if sprites live elsewhere). This re-fetches ~1000+ species from PokéAPI and will take several minutes.

```bash
npx tsx tools/catalog/import-pokemon.ts
```

Expected: script prints `resolved N/M pokemon names`, `resolved N/M rarities`, then `Wrote <count> cards to .../cards.csv and copied images to .../public/cards` followed by a `Rarity breakdown: {...}` object.

- [ ] **Step 3: Rebuild the catalog and seed SQL**

```bash
npm run catalog:build
```

Expected: `Wrote <count> cards to .../catalog.json and .../seed-cards.sql`

- [ ] **Step 4: Spot-check known species against the design spec's examples**

```bash
grep -E "^p[0-9]+(-shiny)?,(Fearow|Kadabra|Raichu|Alakazam|Dragonite|Gyarados|Tyranitar|Snorlax|Nihilego|Great Tusk)," tools/catalog/cards.csv
```

Expected rarities in the matched rows: Fearow → `common`, Kadabra → `common`, Raichu → `rare`, Alakazam → `rare` (capture_rate 50 falls in the 46-89 rare band, not epic — corrected during Task 1 review), Dragonite → `epic`, Gyarados → `epic`, Tyranitar → `epic`, Snorlax → `epic`. (Nihilego and Great Tusk will show their *raw* capture-rate-derived rarity here, since the legendary/epic named-species floor from Task 2 is applied later in `catalog.json`/`seed-cards.sql` by `build-catalog.ts`, not in `cards.csv` itself.)

```bash
node -e "const c = require('./catalog.json'); const names = ['Nihilego','Great Tusk','Fearow']; for (const n of names) console.log(n, c.find(x => x.name === n)?.rarity)"
```

Expected: `Nihilego legendary`, `Great Tusk epic`, `Fearow common`.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```

Expected: PASS

- [ ] **Step 6: Commit the regenerated catalog data**

`catalog.json` and `tools/catalog/seed-cards.sql` are gitignored (generated
locally by `catalog:build`, per the existing convention — see commit
`c97c88a`). Only `cards.csv` is source-of-truth and tracked:

```bash
git add tools/catalog/cards.csv
git commit -m "chore: regenerate card catalog with capture-rate-based rarity"
```

- [ ] **Step 7: Apply the seed to local D1**

```bash
npx wrangler d1 execute twitch-cards-db --local --file=tools/catalog/seed-cards.sql
```

Expected: command completes without error, reporting the number of queries executed.

- [ ] **Step 8: Apply the seed to remote (production) D1 — requires explicit confirmation first**

This mutates the live database and changes the displayed rarity of every card every user currently owns (confirmed intentional in the design spec). **Pause here and get explicit confirmation from the user immediately before running this command against production** — do not run it automatically as part of batch execution.

```bash
npx wrangler d1 execute twitch-cards-db --remote --file=tools/catalog/seed-cards.sql
```

Expected: command completes without error, reporting the number of queries executed.

- [ ] **Step 9: Post-rollout verification against production**

```bash
npx wrangler d1 execute twitch-cards-db --remote --command "SELECT id, name, rarity FROM cards WHERE name IN ('Fearow','Dragonite','Gyarados','Tyranitar','Snorlax')"
```

Expected: Fearow → `common`, the rest → `epic`.

---

## Self-Review Notes

- **Spec coverage:** capture_rate thresholds (Task 1), starter no-exception (Task 1, no special-case code added), Mega/Gmax floor + named-species floor moved into code (Task 2), regeneration + retroactive D1 rollout (Task 3, with explicit production confirmation gate) — all spec sections have a corresponding task.
- **Type consistency:** `Rarity` exported from both `import-pokemon.ts` (Task 1) and `build-catalog.ts` (pre-existing, unchanged) are separate identical type aliases in separate files, matching the existing pattern in this codebase (`import-pokemon.ts` already duplicated `Rarity` locally before this plan rather than importing from `build-catalog.ts`) — no cross-file import needed since the two scripts don't import from each other today.
- **No placeholders:** every step has literal code or exact commands with expected output.
