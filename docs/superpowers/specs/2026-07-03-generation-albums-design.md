# Generation albums with book-style pagination — design spec

## Goal

Split the single 3154-card album into 9 per-generation albums (Kanto..Paldea). Each album is paginated like a physical sticker book: 4x4 grid per page, 2 pages visible at once, page-turn animation + sound. Pack opening lets the user pick which album's card pool to draw from.

## 1. Generation classification

Every card gets a persisted `generation` (1-9) on the `cards` table, computed once and stored — not recomputed per request.

**Base rule:** derive from the real national Pokédex number, which is already encoded in `sort_order` as `floor(sort_order / 1_000_000)` (verified against the live catalog: e.g. `Rattata Alola` → 19, `Mega Charizard` → 6, `Gholdengo` → 1000).

```
dex 1-151    -> Gen 1
dex 152-251  -> Gen 2
dex 252-386  -> Gen 3
dex 387-493  -> Gen 4
dex 494-649  -> Gen 5
dex 650-721  -> Gen 6
dex 722-809  -> Gen 7
dex 810-905  -> Gen 8
dex 906-1025 -> Gen 9
```

**Overrides** (a card whose form was introduced later than its base species — per generation of introduction, not base dex), checked before the base rule, first match wins:

| Condition | Generation |
|---|---|
| `category = 'mega'` | 6 |
| `category = 'gmax'` | 8 |
| name contains `"Alola"` | 7 |
| name contains `"Galar"` | 8 |
| name contains `"Hisui"` | 8 |
| name contains `"Paldea"` | 9 |

Verified against the live catalog: these keywords match exactly the regional-form cards (40 Alola, 40 Galar, 34 Hisui, 8 Paldea) with no false positives among other alt-form names (`Primal`, `Origin`, `Therian`, `Crowned`, `Eternamax`, `Totem` — none of these are in scope per the user's request and all resolve correctly via the base-dex rule already, since those forms don't change the Pokémon's generation). Species with their own unique dex number (e.g. Sirfetch'd, Kleavor, Wyrdeer) need no override — the base rule already places them correctly.

### Schema change

New migration `migrations/0006_card_generation.sql`:
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
(`sort_order` is `INTEGER`, so `/` truncates — matches the JS `Math.floor` semantics used elsewhere in the codebase, e.g. `src/card.ts:73`.)

### Catalog tooling

`tools/catalog/build-catalog.ts`:
- Add `computeGeneration(name: string, category: Category, sortOrder: number): number` implementing the same precedence rules.
- `CatalogEntry` gains `generation: number`.
- `seedSql` INSERT statements and `catalog.json` output gain the `generation` column/field.

### Worker/API consumers

- `worker/types.ts`: `CardView`/query results gain `generation: number`.
- `worker/routes/collection.ts` `GET /collection`: select `c.generation` alongside existing columns so the client receives it per card.
- `src/api.ts` `CardView` interface: add `generation: number`.

## 2. Album picker (`album.html` with no `?gen=`)

`album.html` becomes stateful based on `?gen=N` in the URL:
- **No `gen` param:** render a picker — a grid of 9 album covers, one per generation, labeled with the region name (Kanto, Johto, Hoenn, Sinnoh, Teselia, Kalos, Alola, Galar, Paldea) and an owned/total counter for that generation (computed client-side from the already-fetched `/api/collection` payload, grouped by `generation`). Each cover links to `album.html?gen=N`.
- **`gen` param present:** render the book view for that generation (section 3). A "← Álbumes" link goes back to the picker. If `gen` is not `1`-`9`, treat as missing (show picker).

No new API endpoint needed — `/api/collection` already returns the full catalog with quantities; the `generation` field (new) lets the client filter/group without extra round-trips. Payload size is unchanged in shape, just one more integer field per card.

## 3. Book view (per-generation album)

- Cards for the selected generation are filtered client-side (`cards.filter(c => c.generation === gen)`), sorted by `sortOrder` (existing `compareCards` with `"pokedex"` field).
- Paginate into pages of 16 (4x4 grid). Pages are grouped into spreads of 2 (left + right), mimicking an open book. First spread shown on load = pages 1-2.
- If the last page has fewer than 16 cards, or a spread has only one page (odd page count), the missing slots render as empty page-texture placeholders (no card art, no click behavior) — the grid stays a fixed 4x4/4x4 shape regardless of where a generation's card count lands.
- Navigation: prev/next arrow buttons flip by one whole spread (2 pages), not a single page. Buttons disable at the first/last spread. A text indicator shows "Páginas X–Y de Z".
- **Animation:** the entire visible spread (both pages) rotates as one rigid unit around the vertical center axis using a CSS 3D transform (`perspective` on the book container, `rotateY` on the spread element: outgoing spread animates 0deg → -90deg while fading, then the new spread's DOM is swapped in and animates 90deg → 0deg). This is a "whole-spread cross-flip", not a physically double-sided single-page flip (that would need per-page front/back faces and independent left/right flip direction — meaningfully more complex, not required by the ask of "a page-turn animation"). Total transition ~450-500ms.
- **Sound:** a page-flip audio file (user-provided, e.g. `public/page-flip.mp3`) plays once at the start of the flip animation, same pattern as the existing shiny sound (`new Audio(...).play().catch(() => {})` in `src/collection.ts:76`).
- Card rendering reuses the existing `renderCardHtml` from `src/card.ts` unchanged (owned/unowned styling, shiny icon, gender icon, info tooltip all carry over as-is).

### Files: `src/album.ts` (rewritten) for data-fetching/picker, plus a new `src/album-book.ts` holding the pure pagination math (card list → pages → spreads, slice bounds, padding) and the flip/sound DOM logic, kept separate so the picker and book concerns don't tangle in one file.

## 4. Pack opening with album choice

- `src/collection.ts` `renderPendingPacks`: clicking a pending pack image no longer opens it immediately. Instead it opens a small modal listing the 9 generations (name + region), user picks one, then `openPack(pack.id, generation)` fires.
- `src/api.ts` `openPack`: signature becomes `openPack(packId: number, generation: number)`, sends `{ generation }` in the POST body.
- `worker/routes/collection.ts` `POST /packs/:id/open`: reads `generation` from the request body (validate it's an integer 1-9, else 400), and the catalog query becomes `SELECT id, rarity, category FROM cards WHERE generation = ?` bound to it. `pickRandomCards` logic is unchanged — it just runs over the filtered set. Every generation has cards for every populated rarity/category bucket that exists catalog-wide today (spot-checked: no generation is missing an entire rarity tier), so no new empty-pool edge case beyond what `pickRandomCards` already throws on (`catalog.length === 0`).
- The pack itself does not persist which generation it was opened for — this is a draw-time filter only, not stored state. (No schema change to `packs`.)
- `collection.html`'s flat "Obtenidas" grid is unchanged — it keeps showing all owned cards across every generation, since it's the trade/sorting reference view, not the album.

## Out of scope

- No changes to `collection.html`'s owned-cards grid beyond the pack-opening modal.
- No changes to rarity/category/shiny pack odds (`worker/lib/packs.ts` weight logic untouched, just fed a pre-filtered catalog).
- No persistence of "which album a pack was opened for" on the `packs` row.
- No jump-to-page/thumbnail navigation in the book view — only prev/next by spread.
- No retroactive changes to `user_cards` — the migration only adds/backfills the `generation` column on `cards`.

## Verification

- `tools/catalog/build-catalog.test.ts`: add cases for `computeGeneration` — base-dex ranges at boundary values (151/152, 386/387, etc.), each override keyword, and override-wins-over-base-dex precedence (e.g. a Gen1-dex Alolan form → 7, not 1).
- `test/routes/collection.test.ts`: extend pack-open tests to cover the `generation` filter (opening with `generation=3` only ever returns Gen 3 cards) and the 400 case for a missing/invalid `generation`.
- No unit tests planned for the client-side pagination/flip logic — consistent with the existing codebase, which has no tests for `src/*.ts` client code today (e.g. `src/card.ts`'s equally intricate `computeFormLabels`/`splitCardName` logic is untested); covered by manual verification below instead.
- Manual: after rollout, spot-check `wrangler d1 execute --remote --command "SELECT id, name, generation FROM cards WHERE id IN ('p1','p10103','p10033','p10195','p10253')"` — expect Bulbasaur→1, Vulpix Alola→7, Mega Charizard→6, a Gmax card→8, Wooper Paldea→9.
- Manual in-browser: open each of the 9 albums, flip forward/back through all spreads including the ragged last page; open a pack, confirm the drawn cards' generation matches the chosen album.

## Rollout (production data)

1. `npm run catalog:build` to regenerate `catalog.json` / `seed-cards.sql` with `generation` populated.
2. Apply `0006_card_generation.sql` to local and remote D1 via `wrangler d1 migrations apply`.
3. Deploy the worker + client changes.
4. Applying to production D1 is a manual step requiring explicit confirmation at execution time — it mutates the live database.
