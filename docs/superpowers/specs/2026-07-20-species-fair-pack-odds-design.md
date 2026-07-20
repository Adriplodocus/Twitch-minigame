# Species-fair pack odds — design spec

> **Amendment (2026-07-20, later same day):** Part 2 ("no-repeat-species-per-pack") was implemented and then reverted at the requester's call. It applied to every species uniformly, not just multi-form ones — a normal single-form species (e.g. Wobbuffet) also became unable to appear twice in the same pack, which was never the complaint and felt like an artificial restriction. The weight-fairness fix (Part 1) already puts a multi-form species' odds of appearing twice in one pack on par with any other species doing so — ordinary variance, not flooding — so Part 2 was judged unnecessary on top of it. Only Part 1 (species-fair weighting in `buildCardWeights`) remains in `worker/lib/packs.ts`; `pickRandomCards` and `pickExactCards` are back to independent draws with replacement, no species-exclusion set, no fallback rule.

## Goal

Multi-form species (Unown: 28 forms in gen 2, Pikachu: ~17 cap/event forms scattered across generations) are each modeled as independent card rows in the catalog with no species/family concept anywhere in the schema. Today's weighted draw splits a rarity+category's weight budget evenly **per card row**, so a 28-form species silently gets ~28x the pack odds of a 1-form species in the same bucket, and packs can hand out several forms of the same species back to back. Fix both:

1. Normalize pack odds so a species' *total* pull chance doesn't scale with how many form-variants it happens to have in the catalog.
2. Prevent the same species from appearing twice within a single pack.

## Current state

`worker/lib/packs.ts:37-84` (`buildCardWeights`) buckets the catalog by `(rarity, category)`, computes that bucket's weight budget, splits it shiny/non-shiny via `splitShinyWeight` (`packs.ts:25-35`), then divides the resulting budget evenly across every card row in that bucket. Card rows are the only unit of division — there is no species grouping.

`pickRandomCards` (`packs.ts:129-152`) and `pickExactCards` (`packs.ts:96-127`) both draw independently with replacement — no state is carried between individual card picks within a pack, so nothing stops the same species (or even the exact same card) from being drawn multiple times in one 10-card pack.

Species identity is not stored anywhere in the DB. The only existing grouping is frontend-only and cosmetic: `src/card.ts:88-110` (`computeFormLabels`) groups cards by `Math.floor(sortOrder / 1_000_000)` (the Pokédex number encoded in `sort_order`) purely to shorten displayed names (e.g. "Unown" + badge "B" instead of "Unown B"). It doesn't affect odds or counts.

`cards.sort_order` is already selected in `collection.ts:12` (viewer collection list) and `trade.ts:20`, but **not** in the two queries that feed the pack draw: `collection.ts:51` (`SELECT id, rarity, category FROM cards WHERE generation = ?`, real pack-open) and `admin.ts:256` (same shape, admin test/grant packs).

## Species key

Reuse the exact formula already proven in `card.ts:94`:

```ts
const speciesKey = (sortOrder: number) => Math.floor(sortOrder / 1_000_000);
```

No CSV or schema change — derived at runtime from the existing `sort_order` column. This becomes a small shared helper (e.g. exported from `packs.ts`, since that's now the only other consumer) rather than duplicated logic.

## Weight algorithm change

`buildCardWeights` (`packs.ts:37-84`) changes what a `(rarity, category, shiny)` bucket's budget is divided by:

- **Today:** `budget / cardCountInBucket` → every row gets an equal slice.
- **New:** `budget / distinctSpeciesInBucket`, then that per-species slice is divided again by how many rows that species has in the bucket (`speciesBudget / rowsOfThisSpeciesInBucket`).

Concretely, extend the existing counting pass (`countsByRarityCategory`, `packs.ts:44-59`) to also track, per `(rarity, category)`, the **set** of distinct species present among shiny cards and among non-shiny cards (not just counts) — `Set<number>` keyed by `speciesKey`. The shiny/non-shiny budget split itself is unchanged (`splitShinyWeight`'s zero-count branches still key off card counts, since count is 0 iff the species set is empty). What changes is the final per-card division: instead of `budget / counts.nonShiny` (or `.shiny`), it becomes `(budget / nonShinySpecies.size) / rowsOfThisCardsSpeciesAmongNonShinyInBucket`.

Effect: within gen 2's `(common, normal, non-shiny)` bucket, Unown (28 rows, 1 species) and any other single-form common species now get equal total pull weight; each individual Unown letter gets 1/28 of what a single-form species gets. Same mechanism fixes Pikachu's cap/event forms wherever they land.

## No-repeat-species-per-pack

Both draw functions gain a `Set<number>` of species already picked in the current pack call, and exclude those species' rows from the pool for subsequent picks within that same call:

- **`pickRandomCards`** (`packs.ts:129-152`): each iteration, filter `catalog` to rows whose species isn't in the seen-set yet; if that filtered pool is non-empty, roll against it (using the already-computed `weights` map, summing only the filtered subset); if the filtered pool is **empty** (bucket exhausted — every species in this generation already appeared in this pack), fall back to the full unfiltered catalog for that one draw only, per the agreed fallback rule. Add the chosen card's species to the seen-set after each pick.
- **`pickExactCards`** (`packs.ts:96-127`): same seen-set, shared across the per-rarity loop and the shiny loop (it's all one pack). Each pool lookup (`packs.ts:106`, `114`) first filters out already-seen species from `pool`/`shinyPool`; falls back to the unfiltered pool if that leaves nothing. The pre-existing empty-pool error checks (`packs.ts:107`, `115`) are about a rarity having *zero* cards at all in the generation, which is unrelated and unchanged.

Both functions' generic constraints gain `sortOrder: number` (currently `pickRandomCards<T extends { id, rarity, category }>`, `pickExactCards<T extends { id, rarity }>`).

## Callers to update

- `worker/routes/collection.ts:51` — query becomes `SELECT id, rarity, category, sort_order AS sortOrder FROM cards WHERE generation = ?`; the inline result type (`collection.ts:53-57`) gains `sortOrder: number`.
- `worker/routes/admin.ts:256` — same treatment; result type (`admin.ts:258`, `263`) gains `sortOrder: number`.

No other consumer changes — `sortOrder` isn't surfaced in either route's JSON response (both already only return `id, name, rarity, image_path, quantity` per existing pack-open payload shape), it's only used internally by the draw functions.

## Out of scope

- No CSV or migration changes — `sort_order` already exists and is already trusted for this exact grouping on the frontend.
- No album changes (`src/album.ts`, `album-book.ts`) — completion % denominator still counts individual form rows, unchanged.
- No retroactive fix for duplicates already in `user_cards` — confirmed forward-only fix. Existing `trade.ts` remains the only way to offload old dupes.
- No changes to `RARITY_WEIGHTS_BY_TIER`, `SHINY_CHANCE_BY_TIER`, or `CATEGORY_WEIGHTS` values themselves — only how a bucket's existing budget is subdivided.
- No change to `pickExactCards`' rarity-exhausted error behavior (`packs.ts:107,115`) — that's "zero cards of this rarity exist", a different failure mode from "species pool exhausted mid-pack", which never throws (falls back instead).

## Verification

- `worker/lib/packs.test.ts`:
  - Species weight parity: catalog with one species carrying many rows (mimicking Unown, same rarity/category/shiny-ness) alongside a single-row species in the same bucket — assert the multi-row species' **summed** weight equals the single-row species' weight (not N×).
  - No-repeat-species within a pack: catalog with several distinct species (each with multiple rows) in one bucket, draw `count == number of distinct species`, assert every pick has a unique `speciesKey`.
  - Fallback correctness: catalog containing only one species (multiple rows), draw `count > 1` — must not throw, and picks beyond the first are allowed to repeat that species (nothing else exists).
  - Same three cases mirrored for `pickExactCards` where applicable (species-fairness across a forced rarity/shiny composition).
- Manual: open a gen 2 "gratis" pack repeatedly (or use the admin test-pack tool at generation 2) and confirm no pack contains two Unown forms, and that Unown doesn't dominate common pulls over many packs the way it does today.
