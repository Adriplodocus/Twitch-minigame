# Catch-rate-based card rarity — design spec

## Goal

Replace the current rarity heuristic (evolution-stage depth) with PokéAPI
`catch_rate`, so rarity reflects actual in-game scarcity instead of "is this
an evolved form." Current logic (`import-pokemon.ts::getRarity`) assigns
`rare` to any Pokémon one evolution away from a base form, regardless of how
common that Pokémon actually is — e.g. Fearow (Spearow → Fearow, a common
early-route bird) is `rare` today purely because it has one evolution.

## Problem with current logic

```
legendary: is_legendary || is_mythical
epic:      evolvesFrom a Pokémon that itself evolvesFrom something (3rd stage)
rare:      evolvesFrom a Pokémon with no further parent (2nd stage)
common:    no evolvesFrom (base form)
```

This conflates "number of evolutions" with "rarity." It misclassifies
ordinary two-stage Pokémon (Fearow, Raticate, Persian, Arbok, etc.) as
`rare`, while treating genuinely notable single-stage or non-evolving
Pokémon (Snorlax, Lapras, Tauros, Chansey) as `common`.

## New rarity algorithm

In `import-pokemon.ts::getRarity`, replace the evolution-chain check with
PokéAPI `catch_rate` (already available on the `pokemon-species` endpoint,
which the script already fetches for `is_legendary`/`is_mythical`):

```
legendary: is_legendary || is_mythical
epic:      catch_rate <= 45
rare:      catch_rate 46-89
common:    catch_rate >= 90
```

No special-case for starters — their catch_rate (45, since they're normally
gift Pokémon rather than wild-caught) is left to fall through the same rule
as everything else, landing first-stage starters (Bulbasaur, Charmander,
Squirtle, etc.) in `epic` alongside their evolutions. This is intentional:
the design deliberately avoids a growing pile of species-specific
exceptions in favor of one consistent, data-driven rule.

Example classifications under the new thresholds:

| Species | catch_rate | New rarity |
|---|---|---|
| Fearow | 90 | common |
| Kadabra | 100 | common |
| Raichu | 75 | rare |
| Alakazam | 50 | rare |
| Dragonite | 45 | epic |
| Gyarados | 45 | epic |
| Tyranitar | 45 | epic |
| Snorlax | 25 | epic |
| Metagross | 3 | epic (not `is_legendary`, so floored by catch_rate not the legendary flag) |

## Structural floors move from CSV edits into code

Today, two prior fixes are applied as one-off direct edits to
`tools/catalog/cards.csv`:

- `ec9ad7f` — Mega/Gmax cards floored to `rare` minimum.
- `5a515f0` — Ultra Beasts and legendary-based Paradox Pokémon floored to
  `legendary`; remaining Paradox forms floored to `epic`.

Problem: `import-pokemon.ts` regenerates `cards.csv` **from scratch** on
every run (no merge with existing rows), so re-running it to pick up new
sprites would silently wipe these manual floors. This spec fixes that by
moving both floors into `tools/catalog/build-catalog.ts`, applied as a
post-processing step on top of the raw `rarity` value read from the CSV, so
they survive any future CSV regeneration:

1. **Category floor**: after `computeCategory(row.name)` runs, if the
   result is `mega` or `gmax`, floor the card's effective rarity to at
   least `rare` (rank order `common < rare < epic < legendary`; take the
   max of the CSV value and `rare`). Needed because a Mega/Gmax form
   inherits its base species' `catch_rate` — e.g. Gmax Meowth would
   otherwise land on `common` since regular Meowth's catch_rate is 255.
2. **Named-species floor**: a hardcoded list (ported verbatim from the
   species named in `5a515f0`'s commit message/spec) mapping Ultra
   Beast/Paradox species names to a minimum rarity (`legendary` or
   `epic`), applied the same way (max of CSV value and the floor). The
   implementer should re-verify each floor is still necessary — some of
   these species may already satisfy their floor automatically once
   `is_legendary`/`catch_rate` are recomputed with the new algorithm, in
   which case the floor is a redundant no-op for that entry, which is
   harmless.

`cards.csv`'s `rarity` column becomes the raw catch_rate/legendary-derived
value; `build-catalog.ts` is the single source of truth for the *effective*
rarity written to `catalog.json` and `seed-cards.sql`. No more manual CSV
patching after the fact for structural cases.

## Retroactive effect (confirmed, intentional)

`user_cards` stores only `card_id` + `quantity` — no rarity snapshot.
Collection/pack/trade queries all join live against `cards.rarity`
(`worker/routes/collection.ts`, `worker/routes/trade.ts`). This means
re-seeding `cards` changes the *displayed* rarity for every card already
owned by every user — e.g. a Fearow a user already owns today (shown as
`rare`) will show as `common` after rollout. This is intentional: rarity is
treated as a property of the catalog entry, not a property of when it was
obtained. No schema change to add a rarity snapshot.

## Rollout

1. Update `getRarity()` in `tools/catalog/import-pokemon.ts` to the
   catch_rate algorithm above.
2. Add the category floor and named-species floor to
   `tools/catalog/build-catalog.ts`.
3. Re-run `import-pokemon.ts` to regenerate `tools/catalog/cards.csv` (all
   ~3155+ cards get their `rarity` recomputed from live PokéAPI data).
4. Run `npm run catalog:build` to regenerate `catalog.json` and
   `tools/catalog/seed-cards.sql` with the new rarities (floors applied).
5. Re-apply `tools/catalog/seed-cards.sql` to local D1 (dev) and remote D1
   (production) via `wrangler d1 execute` — `INSERT OR REPLACE` keyed by
   `id` updates the `rarity` column on existing rows without touching
   `user_cards`/`packs`. Applying to production requires explicit
   confirmation at execution time, separate from this design's approval.

## Out of scope

- No changes to `category` computation (`inicial`/`mega`/`gmax`/`normal`)
  beyond using its output to drive the new rarity floor — the category
  values themselves are unchanged.
- No changes to `RARITY_WEIGHTS` or `CATEGORY_WEIGHTS` in
  `worker/lib/packs.ts` — this only changes which rarity bucket each
  species falls into, not the pack-opening probability weights per bucket.
- No rarity snapshot / historical rarity tracking — retroactive change is
  intentional (see above).
- No starter-specific exception — first-stage starters follow the same
  catch_rate rule as everything else.

## Verification

- `tools/catalog/build-catalog.test.ts`: extend with cases for the new
  category floor (mega/gmax card with a high-catch_rate base species still
  gets floored to `rare`) and the named-species floor (an Ultra
  Beast/Paradox species gets floored regardless of its computed catch_rate
  tier).
- `tools/catalog/import-pokemon.ts` has no existing test file for
  `getRarity` (it's not exported/testable in isolation today — it's a
  private async function that hits the network). If feasible, extract a
  pure `classifyRarity(catchRate, isLegendary, isMythical): Rarity`
  function and unit test the thresholds directly; otherwise rely on the
  `build-catalog.test.ts` coverage plus a manual spot-check.
- Manual: after rollout, spot-check known species via `wrangler d1 execute
  --remote --command "SELECT id, name, rarity FROM cards WHERE name IN
  ('Fearow','Dragonite','Gyarados','Tyranitar','Snorlax')"` — expect Fearow
  → `common`, the rest → `epic`.
