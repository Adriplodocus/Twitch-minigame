# Ultra Beast / Paradox rarity floor — design spec

## Goal

Ultra Beasts and most Paradox Pokémon are currently `common` (or `rare` for
Naganadel) in `tools/catalog/cards.csv`, which doesn't match their in-game
power level — several are directly based on legendary Pokémon. Floor their
card rarity to match, following the same direct-CSV-edit pattern already
used for the Mega/Gmax rarity floor fix (commit `ec9ad7f`).

## Rule

- **All 11 Ultra Beasts** → `legendary`: Nihilego, Buzzwole, Pheromosa,
  Xurkitree, Celesteela, Kartana, Guzzlord, Poipole, Naganadel, Stakataka,
  Blacephalon.
- **Paradox Pokémon based on a legendary species** → `legendary`: Walking
  Wake (Suicune), Iron Leaves (Virizion), Gouging Fire (Entei), Raging Bolt
  (Raikou), Iron Boulder (Ogerpon), Iron Crown (Terapagos).
- **All other Paradox Pokémon** → `epic` (floor, minimum): Great Tusk, Scream
  Tail, Brute Bonnet, Flutter Mane, Slither Wing, Sandy Shocks, Iron Treads,
  Iron Bundle, Iron Hands, Iron Jugulis, Iron Moth, Iron Thorns, Roaring
  Moon, Iron Valiant.
- Koraidon and Miraidon are already `legendary` (box legendaries) — untouched.
- Both the base id and its `-shiny` counterpart get the same new rarity
  (matching the existing shiny-pairing convention already used everywhere
  else in `cards.csv`).

## Change

Direct edits to the `rarity` column in `tools/catalog/cards.csv` for the ~31
species listed above (62 rows counting shiny pairs) — no code logic changes,
matching the precedent set by `ec9ad7f`.

## Rollout

1. `npm run catalog:build` to regenerate `catalog.json` and
   `tools/catalog/seed-cards.sql` with the new rarities.
2. Re-apply `tools/catalog/seed-cards.sql` to local D1 (dev) and remote D1
   (production) via `wrangler d1 execute` — `INSERT OR REPLACE` keyed by
   `id` updates the `rarity` column on existing rows without touching
   `user_cards`/`packs`.

## Out of scope

- No changes to `RARITY_WEIGHTS`, `CATEGORY_WEIGHTS`, or any pack-opening
  probability logic in `worker/lib/packs.ts` — this only changes which
  rarity bucket these specific cards fall into, not the bucket weights
  themselves.
- No changes to the `category` column (`inicial`/`mega`/`gmax`/`normal`) —
  Ultra Beasts and Paradox Pokémon are not starters, so they're already
  (correctly) `normal` category, unaffected by this change.
- No retroactive changes to cards already owned by users (`user_cards` rows
  are untouched — only the `cards` catalog table's `rarity` column changes).
