# Capture-Rate-45 BST Tiebreak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Within the capture_rate=45 cluster (currently all classified `epic`, ~30% of the dex), use base-stat-total (BST) as a tiebreaker so genuinely notable species (Dragonite, fossils, Kangaskhan...) stay `epic` while ordinary ones (Onix, Dodrio, Beedrill...) drop to `rare`.

**Architecture:** One pure-function change (`classifyRarity` gains a 4th parameter and a new branch) plus the data fetch needed to supply it (`getSpecies` gains a second PokéAPI call for `stats`), followed by the same regenerate-and-roll-out operational task used for the original catch-rate change.

**Tech Stack:** TypeScript, Vitest, tsx, PokéAPI (`pokemon-species` + `pokemon` endpoints), Cloudflare D1/Wrangler.

## Global Constraints

- Rule (exact, from spec): `legendary` = `is_legendary || is_mythical`; `epic` = `capture_rate < 45`; at `capture_rate === 45`, `epic` requires `base_stat_total >= 490` else `rare`; `rare` = `capture_rate` 46–89 (BST irrelevant); `common` = `capture_rate >= 90` (BST irrelevant).
- BST is fetched once per species (not per card-form/variant) from `/api/v2/pokemon/{speciesName}` — same granularity `capture_rate` already uses.
- No schema/migration change.
- No changes to `RARITY_WEIGHTS` / `CATEGORY_WEIGHTS` in `worker/lib/packs.ts`.
- No changes to `tools/catalog/build-catalog.ts` — the Mega/Gmax and named-species floors already compose correctly on top of whatever raw rarity `import-pokemon.ts` produces; this plan does not touch that file.
- Threshold `490` is a judgment call (no clean natural gap in the data), already confirmed with the human during design — do not re-derive it.
- Retroactive effect is intentional (already established and confirmed in the prior rollout) — the same regenerate-and-reseed rollout applies here.

---

### Task 1: BST-aware `classifyRarity` in `import-pokemon.ts`

**Files:**
- Modify: `tools/catalog/import-pokemon.ts`
- Modify (test): `tools/catalog/import-pokemon.test.ts`

**Interfaces:**
- Produces: `export function classifyRarity(captureRate: number, isLegendary: boolean, isMythical: boolean, baseStatTotal: number): Rarity` (signature change — 4th parameter added; every existing call site in the test file must be updated).
- Produces: `SpeciesInfo.baseStatTotal: number` (new field).

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `tools/catalog/import-pokemon.test.ts` with:

```ts
import { it, expect } from "vitest";
import { classifyRarity } from "./import-pokemon";

it("classifies legendary/mythical regardless of capture rate or BST", () => {
  expect(classifyRarity(45, true, false, 0)).toBe("legendary");
  expect(classifyRarity(3, false, true, 0)).toBe("legendary");
  expect(classifyRarity(255, true, true, 600)).toBe("legendary");
});

it("classifies epic at capture rate below 45, regardless of BST", () => {
  expect(classifyRarity(25, false, false, 100)).toBe("epic");
  expect(classifyRarity(3, false, false, 50)).toBe("epic");
  expect(classifyRarity(30, false, false, 0)).toBe("epic");
});

it("at capture rate exactly 45, epic requires BST >= 490", () => {
  expect(classifyRarity(45, false, false, 490)).toBe("epic");
  expect(classifyRarity(45, false, false, 600)).toBe("epic");
});

it("at capture rate exactly 45, BST below 490 falls to rare", () => {
  expect(classifyRarity(45, false, false, 489)).toBe("rare");
  expect(classifyRarity(45, false, false, 385)).toBe("rare");
});

it("classifies rare at capture rate 46 to 89, regardless of BST", () => {
  expect(classifyRarity(46, false, false, 0)).toBe("rare");
  expect(classifyRarity(75, false, false, 300)).toBe("rare");
  expect(classifyRarity(89, false, false, 600)).toBe("rare");
});

it("classifies common at capture rate 90 and above, regardless of BST", () => {
  expect(classifyRarity(90, false, false, 0)).toBe("common");
  expect(classifyRarity(255, false, false, 600)).toBe("common");
});

it("matches known species thresholds from the design spec", () => {
  expect(classifyRarity(90, false, false, 442)).toBe("common"); // Fearow
  expect(classifyRarity(100, false, false, 400)).toBe("common"); // Kadabra
  expect(classifyRarity(75, false, false, 485)).toBe("rare"); // Raichu
  expect(classifyRarity(50, false, false, 500)).toBe("rare"); // Alakazam
  expect(classifyRarity(25, false, false, 540)).toBe("epic"); // Snorlax
  expect(classifyRarity(3, false, false, 600)).toBe("epic"); // Metagross (no legendary flag)
});

it("separates the capture_rate=45 cluster by BST: notable species stay epic", () => {
  expect(classifyRarity(45, false, false, 600)).toBe("epic"); // Dragonite
  expect(classifyRarity(45, false, false, 540)).toBe("epic"); // Gyarados
  expect(classifyRarity(45, false, false, 490)).toBe("epic"); // Kangaskhan (boundary)
  expect(classifyRarity(45, false, false, 495)).toBe("epic"); // Omastar/Kabutops (fossils)
  expect(classifyRarity(45, false, false, 525)).toBe("epic"); // Venusaur (starter final)
});

it("separates the capture_rate=45 cluster by BST: ordinary species drop to rare", () => {
  expect(classifyRarity(45, false, false, 385)).toBe("rare"); // Onix
  expect(classifyRarity(45, false, false, 470)).toBe("rare"); // Dodrio
  expect(classifyRarity(45, false, false, 395)).toBe("rare"); // Beedrill
  expect(classifyRarity(45, false, false, 318)).toBe("rare"); // Bulbasaur (starter, first stage)
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tools/catalog/import-pokemon.test.ts`
Expected: FAIL — `classifyRarity` is called with 4 arguments but only accepts 3 (TypeScript type error surfaces as a test-run failure).

- [ ] **Step 3: Implement the BST fetch and the new `classifyRarity` branch**

In `tools/catalog/import-pokemon.ts`, change the `SpeciesInfo` interface (currently lines 23-29) from:
```ts
interface SpeciesInfo {
  name: string;
  dexNumber: number;
  isLegendary: boolean;
  isMythical: boolean;
  captureRate: number;
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
  baseStatTotal: number;
}
```

Change `getSpecies` (currently lines 67-79) from:
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
to:
```ts
async function getSpecies(cache: Cache, speciesName: string): Promise<SpeciesInfo> {
  if (cache.species[speciesName]) return cache.species[speciesName];
  const [speciesData, pokemonData] = await Promise.all([
    fetchJson(`https://pokeapi.co/api/v2/pokemon-species/${speciesName}`),
    fetchJson(`https://pokeapi.co/api/v2/pokemon/${speciesName}`),
  ]);
  const baseStatTotal: number = Array.isArray(pokemonData?.stats)
    ? pokemonData.stats.reduce((sum: number, s: { base_stat: number }) => sum + (s.base_stat ?? 0), 0)
    : 0;
  const info: SpeciesInfo = {
    name: speciesName,
    dexNumber: speciesData?.id ?? 0,
    isLegendary: !!speciesData?.is_legendary,
    isMythical: !!speciesData?.is_mythical,
    captureRate: speciesData?.capture_rate ?? 255,
    baseStatTotal,
  };
  cache.species[speciesName] = info;
  return info;
}
```

Note: `/api/v2/pokemon/{speciesName}` 404s for a handful of multi-form species whose default form has a different slug than the species name (e.g. `wormadam`, `basculin`, `giratina`). `fetchJson` already returns `null` on a 404 (see its existing implementation), so `pokemonData` is `null` and `baseStatTotal` falls back to `0` via the `Array.isArray` guard — this is an accepted, documented limitation (see the design spec's "Out of scope" — it fails safe by demoting to `rare` rather than crashing, and does not need to be solved in this task).

Change `classifyRarity` and `getRarity` (currently lines 81-91) from:
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
to:
```ts
export function classifyRarity(
  captureRate: number,
  isLegendary: boolean,
  isMythical: boolean,
  baseStatTotal: number
): Rarity {
  if (isLegendary || isMythical) return "legendary";
  if (captureRate < 45) return "epic";
  if (captureRate === 45) return baseStatTotal >= 490 ? "epic" : "rare";
  if (captureRate <= 89) return "rare";
  return "common";
}

async function getRarity(cache: Cache, speciesName: string): Promise<Rarity> {
  const species = await getSpecies(cache, speciesName);
  return classifyRarity(species.captureRate, species.isLegendary, species.isMythical, species.baseStatTotal);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tools/catalog/import-pokemon.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (all suites; `build-catalog.test.ts` is unaffected since it doesn't import from `import-pokemon.ts`)

- [ ] **Step 6: Commit**

```bash
git add tools/catalog/import-pokemon.ts tools/catalog/import-pokemon.test.ts
git commit -m "feat: tiebreak capture_rate=45 rarity cluster by base stat total"
```

---

### Task 2: Regenerate the catalog and roll out to D1

**Files:**
- Modify (generated, not hand-edited): `tools/catalog/cards.csv`
- Delete (local-only, gitignored): `tools/catalog/.pokeapi-cache.json`

**Interfaces:**
- Consumes: `classifyRarity` (Task 1) and the extended `SpeciesInfo`/`getSpecies` (Task 1) via `import-pokemon.ts`'s `main()`. No new interfaces produced — this task is operational, not code.

This task must run after Task 1 is committed.

- [ ] **Step 1: Delete the stale PokéAPI cache**

`tools/catalog/.pokeapi-cache.json` caches `SpeciesInfo` objects that don't have the new `baseStatTotal` field. It's gitignored (local speed-up cache only) — delete it so every species gets re-fetched with the new field:

```bash
rm -f tools/catalog/.pokeapi-cache.json
```

- [ ] **Step 2: Run the import script to regenerate `cards.csv`**

Requires network access to `pokeapi.co` and the `SPRITE_ROOT` sprite directory (defaults to `C:/Proyectos/SpritesPokemon/sprites/pokemon`). This now makes roughly twice as many PokéAPI requests per unique species as before (species endpoint + pokemon endpoint), so expect it to take longer than the previous run — be patient, don't treat it as stuck.

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
grep -E "^p[0-9]+,(Onix|Dodrio|Beedrill|Kangaskhan|Tauros|Dragonite|Chansey|Ditto|Bulbasaur|Venusaur)," tools/catalog/cards.csv
```

Expected rarities in the matched rows (this is `cards.csv`, the raw Task-1 output — Mega/Gmax and named-species floors from `build-catalog.ts` are unaffected by this plan and apply later at build time as before, but none of these species are in those floor lists so `cards.csv` and `catalog.json` should agree here): Onix → `rare`, Dodrio → `rare`, Beedrill → `rare`, Kangaskhan → `epic`, Tauros → `epic`, Dragonite → `epic`, Chansey → `epic`, Ditto → `epic`, Bulbasaur → `rare`, Venusaur → `epic`.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```

Expected: PASS

- [ ] **Step 6: Commit the regenerated catalog data**

`catalog.json` and `tools/catalog/seed-cards.sql` are gitignored (generated locally by `catalog:build`). Only `cards.csv` is tracked:

```bash
git add tools/catalog/cards.csv
git commit -m "chore: regenerate card catalog with BST-tiebroken rarity"
```

- [ ] **Step 7: Apply the seed to local D1 — requires controller confirmation**

This is handled directly by the controller (not this task's subagent), the same way the prior rollout's D1 steps were: get explicit human confirmation before running, then:

```bash
npx wrangler d1 execute twitch-cards-db --local --file=tools/catalog/seed-cards.sql
```

Expected: command completes without error, reporting the number of queries executed. If it errors with a missing-column message, check `npx wrangler d1 migrations list twitch-cards-db --local` for pending migrations and apply them first (`npx wrangler d1 migrations apply twitch-cards-db --local`) — this happened once before during the original rollout.

- [ ] **Step 8: Apply the seed to remote (production) D1 — requires explicit confirmation first**

This mutates the live database and changes the displayed rarity of every card every user currently owns. **Get explicit confirmation from the user immediately before running this against production.**

```bash
npx wrangler d1 execute twitch-cards-db --remote --file=tools/catalog/seed-cards.sql
```

Expected: command completes without error, reporting the number of queries executed.

- [ ] **Step 9: Post-rollout verification against production**

```bash
npx wrangler d1 execute twitch-cards-db --remote --command "SELECT id, name, rarity FROM cards WHERE name IN ('Onix','Dodrio','Kangaskhan','Tauros','Dragonite','Chansey','Ditto')"
```

Expected: Onix, Dodrio → `rare`; Kangaskhan, Tauros, Dragonite, Chansey, Ditto → `epic`.

---

## Self-Review Notes

- **Spec coverage:** the exact rule (legendary override, `<45` unconditional epic, `===45` BST-gated, `46-89` rare, `>=90` common) is fully implemented in Task 1's `classifyRarity`; the BST fetch shape (per-species, `/api/v2/pokemon/{speciesName}`, sum of `stats[].base_stat`) matches the spec's "Implementation shape" section; the 404-fallback behavior for multi-form species is explicitly called out as accepted per the spec's "Out of scope"; Task 2 mirrors the original rollout's regenerate-then-reseed shape, including the local-D1-migration gotcha encountered last time.
- **Type consistency:** `classifyRarity`'s 4-argument signature is used identically in Task 1's test file and in `getRarity`'s call site — no drift.
- **No placeholders:** every step has literal code or exact commands with expected output.
- **Out of scope confirmed:** no task touches `build-catalog.ts`, `worker/lib/packs.ts`, or any migration file, matching the spec's Global Constraints.
