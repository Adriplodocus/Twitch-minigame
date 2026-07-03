# Base-stat-total tiebreak for the capture_rate=45 cluster — design spec

## Context

Follow-up to `2026-07-03-catch-rate-rarity-design.md`, which replaced
evolution-depth rarity with PokéAPI `capture_rate`. That fix is live in
production and correctly resolved its motivating case (Fearow, capture_rate
90, now `common`). But `capture_rate` has a data quirk: `45` is by far its
most common value — 303 of 1025 species (~30% of the dex) share it. Game
Freak uses `45` as a generic "not a total pushover" bucket, not a fine
rarity signal, so it lumps genuinely notable Pokémon (Dragonite BST 600,
Gyarados BST 540, Tyranitar BST 600, fossils, starter final evolutions)
together with ordinary ones (Onix BST 385, Dodrio BST 470, Beedrill BST
395, Aipom BST 360) — both classified `epic` today, which doesn't match
intuition for the ordinary half.

## Goal

Within the `capture_rate === 45` band only, use `base_stat_total` (BST —
the sum of a Pokémon's 6 base stats from PokéAPI) as a tiebreaker to
separate the two halves.

## Why not other approaches

- **Move the whole `epic` threshold down** (e.g. `capture_rate < 45`
  instead of `<= 45`): rejected — Dragonite, Gyarados, and Tyranitar all
  share `capture_rate = 45` with Onix and Dodrio, so this would demote
  them too. Confirmed by direct PokéAPI lookup during design.
- **BST as the primary signal for all rarity tiers** (not just this
  tiebreak): rejected — BST tracks evolution/power level, not scarcity,
  and reintroduces the original bug in a new form. Confirmed: Fearow's BST
  (442) is higher than Kadabra's (400) and close to Alakazam's (500) —
  using BST broadly would put Fearow in a `rare`/`epic`-adjacent bracket
  again, the exact problem this whole effort set out to fix.
- **BST gate applied to the full `capture_rate <= 45` range** (not just
  `=== 45`): rejected — the sub-45 tail (capture_rate 3–35, 148 species)
  is already well-separated by capture_rate alone and contains known-good
  cases with low BST that must stay `epic`: Chansey (capture_rate 30, BST
  450), Ditto (capture_rate 35, BST 288), Snorlax (capture_rate 25, BST
  540 — fine on BST too, but the point is Chansey/Ditto aren't). Applying
  the gate here would wrongly demote them.

## Rule

```
legendary: is_legendary || is_mythical
epic:      capture_rate < 45
epic:      capture_rate === 45 AND base_stat_total >= 490
rare:      capture_rate === 45 AND base_stat_total < 490
rare:      capture_rate 46-89
common:    capture_rate >= 90
```

Threshold `490` chosen from the actual capture_rate=45 BST distribution
(fetched and inspected during design, no clean natural gap exists — this
is a judgment call, not a discovered boundary). Representative species
right at the boundary:

| Stays `epic` (BST ≥ 490) | Drops to `rare` (BST < 490) |
|---|---|
| Kangaskhan 490, Tauros 490, Electabuzz 490 | Onix 385, Beedrill 395, Butterfree 395 |
| Omastar/Kabutops 495, Aerodactyl 515 | Aipom 360, Dodrio 470, Pidgeot 479 |
| Gengar 500, Scyther 500, Pinsir 500 | Ludicolo 480, Ambipom 482 |
| Machamp 505, Ampharos 510 | Bulbasaur 318, Charmander 309, Squirtle 314 |
| Dragonite 600, Gyarados 540, Tyranitar 600 | Ivysaur 405, Bayleef 405, Charmeleon 405 |
| Charizard 534, Venusaur 525, Blastoise 530 | (starter mid-evolutions generally) |

## Accepted side effect: starters revisited

The prior design explicitly decided "no starter exception, let
capture_rate rule regardless" for first-stage starters (Bulbasaur BST 318,
capture_rate 45 → `epic`). This BST gate reverses that outcome as a side
effect of a general rule, not a reintroduced special case: first-stage and
most mid-stage starter-line Pokémon (BST well under 490) now drop to
`rare`, while starter *final* evolutions (BST 525–535, comfortably above
490) remain `epic`. Confirmed acceptable — the user chose this outcome
explicitly when presented with the conflict during design.

## Implementation shape

- `tools/catalog/import-pokemon.ts`:
  - Extend `SpeciesInfo` (and the on-disk cache shape) with
    `baseStatTotal: number`, fetched from the `/api/v2/pokemon/{speciesName}`
    endpoint's `stats` array (sum of all `base_stat` values) — same
    endpoint pattern already used elsewhere in the script, just reading an
    additional field (`stats`) that isn't currently extracted.
  - `classifyRarity(captureRate, isLegendary, isMythical, baseStatTotal)`
    gains a 4th parameter and the branching above.
- `tools/catalog/build-catalog.ts`: unaffected. `computeRarityFloor` keeps
  operating on whatever raw rarity value ends up in `cards.csv` — the
  Mega/Gmax and Ultra Beast/Paradox floors compose the same way they
  already do with the Task-1 output.
- Cache invalidation: `tools/catalog/.pokeapi-cache.json` (gitignored)
  must be deleted before regenerating, same as the original rollout,
  since existing cached `SpeciesInfo` entries won't have `baseStatTotal`.
- Full re-regeneration of `cards.csv`, rebuild of `catalog.json`/
  `seed-cards.sql`, and re-seed of local + production D1 — same rollout
  shape as the original catch-rate change, same retroactive-effect
  reasoning (already confirmed acceptable in the prior design: rarity is
  a live join against the catalog, not a snapshot).

## Out of scope

- No schema/migration change (rarity CHECK constraint unchanged, still 4
  values).
- No changes to `RARITY_WEIGHTS`/`CATEGORY_WEIGHTS` in `worker/lib/packs.ts`.
- No changes to the Mega/Gmax or named-species floors in `build-catalog.ts`.
- No per-form BST (Mega/regional forms use the base species' BST, same
  granularity `capture_rate` already uses — consistent with the existing
  architecture where rarity is computed once per species and applied to
  every sprite variant of that species).

## Verification

- `tools/catalog/import-pokemon.test.ts`: extend `classifyRarity` tests
  with the new 4th parameter — cases for capture_rate < 45 (BST
  irrelevant, always epic), capture_rate === 45 with BST above/below 490,
  and the unchanged 46-89/`>=90` bands (BST irrelevant there too).
- Manual: after rollout, spot-check via `wrangler d1 execute --remote
  --command "SELECT id, name, rarity FROM cards WHERE name IN
  ('Onix','Dodrio','Kangaskhan','Tauros','Dragonite','Chansey','Ditto')"`
  — expect Onix/Dodrio → `rare`, Kangaskhan/Tauros/Dragonite → `epic`,
  Chansey/Ditto → `epic` (unaffected, capture_rate below 45).
