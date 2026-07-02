# Pack category weights — design spec

## Goal

Introduce a "category" axis (Normal / Inicial / Mega / Gmax) alongside the existing rarity and shiny axes in pack-opening odds, and lower the shiny chance from 10% to 1%.

## Current state (baseline, already correct — no change needed)

`worker/lib/packs.ts` already has:
```ts
export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 70,
  rare: 15,
  epic: 10,
  legendary: 5,
};
```
This matches the requested rarity weights exactly. No change to `RARITY_WEIGHTS`.

## New probabilities

```
SHINY_CHANCE = 0.01   (was 0.1)
CATEGORY_WEIGHTS = { inicial: 0.15, mega: 0.10, gmax: 0.10 }
                    // normal = 1 - (0.15 + 0.10 + 0.10) = 0.65, implicit
```

## Category definition

A card's `category` is one of `'normal' | 'inicial' | 'mega' | 'gmax'`, computed **once at catalog-build time** (not at pack-open time) and stored as a real column on `cards`.

**Rules, in this precedence order:**
1. If the card's species is part of a regional-starter evolutionary line (see full list below) → `inicial`. This wins even if the same card's name also contains "Mega" or "Gmax" (e.g. `"Venusaur Mega"` → `inicial`, not `mega`, because Venusaur is Bulbasaur's final evolution).
2. Else if the name matches `\bMega\b` (word-boundary regex, so `"Meganium"` does NOT match — it's excluded by rule 1 anyway since Meganium is the Chikorita-line starter's final form, but the regex would exclude it independently too) → `mega`.
3. Else if the name matches `\bGmax\b` → `gmax`.
4. Else → `normal`.

**Categories are mutually exclusive.** Shiny is a separate, orthogonal axis (unchanged from today — determined by `-shiny` id suffix) that can combine with any of the four categories.

**Full starter-line species list** (9 generations × 3 evolutionary stages = 81 species; matched as a whole-word prefix of the card name, e.g. `/^Venusaur\b/`, so suffixes like `" Shiny"`, `" (Hembra)"`, `" Mega"` after the species name still match):

```
Gen 1: Bulbasaur, Ivysaur, Venusaur, Charmander, Charmeleon, Charizard, Squirtle, Wartortle, Blastoise
Gen 2: Chikorita, Bayleef, Meganium, Cyndaquil, Quilava, Typhlosion, Totodile, Croconaw, Feraligatr
Gen 3: Treecko, Grovyle, Sceptile, Torchic, Combusken, Blaziken, Mudkip, Marshtomp, Swampert
Gen 4: Turtwig, Grotle, Torterra, Chimchar, Monferno, Infernape, Piplup, Prinplup, Empoleon
Gen 5: Snivy, Servine, Serperior, Tepig, Pignite, Emboar, Oshawott, Dewott, Samurott
Gen 6: Chespin, Quilladin, Chesnaught, Fennekin, Braixen, Delphox, Froakie, Frogadier, Greninja
Gen 7: Rowlet, Dartrix, Decidueye, Litten, Torracat, Incineroar, Popplio, Brionne, Primarina
Gen 8: Grookey, Thwackey, Rillaboom, Scorbunny, Raboot, Cinderace, Sobble, Drizzile, Inteleon
Gen 9: Sprigatito, Floragato, Meowscarada, Fuecoco, Crocalor, Skeledirge, Quaxly, Quaxwell, Quaquaval
```

The implementer must verify each spelling against `tools/catalog/cards.csv` name text during implementation (species names must match exactly, case-sensitive prefix) — some names in the CSV may include regional-form suffixes (e.g. `"Typhlosion Hisui"`) which should still match via the whole-word-prefix rule.

## Schema change

New migration `migrations/0004_card_category.sql`:
```sql
ALTER TABLE cards ADD COLUMN category TEXT NOT NULL DEFAULT 'normal'
  CHECK (category IN ('normal', 'inicial', 'mega', 'gmax'));
```

## Catalog tooling changes

`tools/catalog/build-catalog.ts`:
- Add `Category = "normal" | "inicial" | "mega" | "gmax"` type.
- Add `STARTER_SPECIES: string[]` constant (the 81 names above) and `computeCategory(name: string): Category` function implementing the precedence rules.
- `CatalogEntry` gains a `category: Category` field, computed via `computeCategory(row.name)` in `buildCatalog()`.
- The generated `INSERT OR REPLACE INTO cards (...)` statement in `seedSql` gains the `category` column and value.
- `catalog.json` output gains the `category` field per entry (currently unused at runtime by the worker, which reads only from D1, but kept in sync as the existing pattern already does for every other column).

## Weight algorithm changes

`worker/lib/packs.ts`:
- `SHINY_CHANCE` changes from `0.1` to `0.01`.
- Add `CATEGORY_WEIGHTS: Record<'inicial' | 'mega' | 'gmax', number> = { inicial: 0.15, mega: 0.10, gmax: 0.10 }`.
- `pickRandomCards`'s catalog item type gains `category: Category` (alongside existing `id`, `rarity`).
- `buildCardWeights` is rewritten to nest **rarity → category → shiny**:
  1. Group catalog cards by rarity (as today).
  2. Within each rarity, group by category (`normal`/`inicial`/`mega`/`gmax`).
  3. For each rarity, compute each present category's weight budget: `RARITY_WEIGHTS[rarity] * CATEGORY_WEIGHTS[category]` for inicial/mega/gmax, and `RARITY_WEIGHTS[rarity] * (1 - sum of CATEGORY_WEIGHTS for categories present in this rarity)` for normal.
  4. **Folding rule:** if a category (inicial/mega/gmax) has zero cards in a given rarity, its reserved budget fraction is not distributed — it folds entirely into that rarity's `normal` budget instead (i.e., `normal`'s effective fraction for that rarity becomes `1 - sum(CATEGORY_WEIGHTS of only the categories that actually have ≥1 card in that rarity)`). This mirrors the existing shiny-count-zero handling, which gives 100% of the weight to whichever side has cards rather than proportionally redistributing.
  5. Within each (rarity, category) bucket, split shiny/non-shiny using `SHINY_CHANCE` exactly as today's shiny logic already does (including the existing zero-count edge cases: no shiny variant of that category+rarity → 100% non-shiny; no non-shiny variant → 100% shiny).
  6. Each individual card's weight = its bucket's total budget ÷ number of cards in that exact (rarity, category, shiny) bucket (uniform distribution within the finest bucket, matching today's behavior).

## Consumers to update

- `worker/types.ts`: add `export type Category = "normal" | "inicial" | "mega" | "gmax";`
- `worker/routes/collection.ts:38` — the pack-open catalog query `SELECT id, rarity FROM cards` becomes `SELECT id, rarity, category FROM cards`, and the typed result gains `category: Category`.
- No other consumer changes. This is a probability-only change — no UI displays category, no API response shape changes beyond what `pickRandomCards` already returns internally (the category field is not surfaced in the pack-open response payload, which already only returns `id, name, rarity, image_path, quantity`).

## Rollout (production data)

1. Run `npm run catalog:build` to regenerate `catalog.json` and `tools/catalog/seed-cards.sql` with the new `category` column populated for all 3155 existing cards.
2. Apply migration `0004_card_category.sql` to both local and remote (production) D1 via `wrangler d1 migrations apply`.
3. Re-apply `tools/catalog/seed-cards.sql` (via `wrangler d1 execute --file=`) to both local and remote D1. Since the seed uses `INSERT OR REPLACE` keyed by `id`, this backfills `category` on all existing rows without needing a separate UPDATE/backfill script or touching `user_cards`/`packs`/other tables.
4. Applying to production is a manual step requiring explicit confirmation at execution time (separate from this design's approval) — it mutates the live database.

## Out of scope

- No UI changes (no category badges, no filtering by category in album/collection views).
- No changes to `RARITY_WEIGHTS` (already correct).
- No changes to how shiny/female id-suffix conventions work (`isShinyCard`, `-female` naming) — untouched.
- No changes to the gender-icon/shiny-icon display logic in `src/card.ts` or `src/style.css`.
- No retroactive re-categorization of cards already owned by users (`user_cards` rows are untouched by the migration/reseed — only the `cards` catalog table gains the new column).

## Verification

- `worker/lib/packs.test.ts` and `test/lib/packs.test.ts`: extend with cases for category-weighted distribution (~15%/10%/10%/65% within a rarity), the folding rule (category absent in a rarity → its share goes to normal), and shiny-within-category (1% of each present category).
- `tools/catalog/build-catalog.test.ts`: add cases for `computeCategory` — starter-line prefix match, Mega/Gmax regex (including the Meganium non-match), and the inicial-wins-over-mega precedence case (`"Venusaur Mega"` → `inicial`).
- Manual: after rollout, spot-check a few known cards via `wrangler d1 execute --remote --command "SELECT id, name, category FROM cards WHERE id IN ('p1','p10033','p10195','p154')"` — expect `p1` (Bulbasaur) → `inicial`, `p10033` (Venusaur Mega) → `inicial`, `p10195` (Venusaur Gmax) → `inicial`, `p154` (Meganium) → `inicial`.
