# Shiny albums per generation — design spec

## Goal

Shiny cards are rare and currently get buried inside each generation's normal album (shown after a "Shiny" divider page, mixed into the same completion %). Split them out: each generation gets its own dedicated shiny album, separate from — but discoverable next to — that generation's normal album. Normal-album completion % should no longer be dragged down by shiny luck.

## 1. Picker (`album.html`, no `?gen=`)

`renderPicker` in `src/album.ts` renders two sections on the same page, stacked:
- Existing grid of 9 normal-gen tiles, unchanged in look, but each tile's owned/total count now only counts non-shiny cards for that generation.
- A `<h3>` separator labeled "Shiny", followed by a second grid of 9 shiny-gen tiles (same regions/order), counting only shiny cards for that generation.

Both grids reuse `.album-picker-grid`. Shiny tiles reuse the same `/album-covers/{gen}.webp` background but get an added `.album-cover-shiny` class for a gold border/glow, plus a small `<img class="shiny-icon" src="/shiny-icon.webp">` badge in a corner (same asset already used on card faces in `card.ts:174`).

A generation with zero owned shiny cards still shows its tile (0/N · 0%) — no hiding empty albums, consistent with how normal-gen tiles behave today.

## 2. URL scheme

Shiny tiles link to `album.html?gen=N&shiny=1`. `parseGenParam()` is unchanged; a new `parseShinyParam()` reads `shiny=1` from the query string (any other value, including absent, is `false`).

## 3. Book view (`album-book.ts`)

`buildPages(cards: CardView[])` becomes `buildPages(cards: CardView[], isShiny: boolean)`:
- Filters to `cards.filter(c => splitCardName(c.name).isShiny === isShiny)`, sorts by `albumSortKey`, chunks into pages of 16.
- The `"divider"` page kind and the branch that appends a "Shiny" divider + shiny pages after the normal ones are deleted entirely — a book is now single-type, so there's nothing to divide.
- Odd-page-count padding (final empty page so the spread count is even) still applies, same as today.

`AlbumBook`'s constructor takes the pre-filtered card list from `album.ts` (simplest: `album.ts` filters by `isShiny` before constructing, so `AlbumBook`/`buildPages` doesn't need to know about shiny at all beyond the existing `splitCardName` filter already living in `buildPages`). Rendering (`renderPageHtml`, flip animation, nav) is untouched — it already just walks `BookPage[]`.

## 4. `renderBook` (`album.ts`)

Takes `isShiny` (from `parseShinyParam()`), filters `genCards` by `splitCardName(c.name).isShiny === isShiny` before computing owned/total and constructing `AlbumBook`. Heading becomes "Álbum Shiny - Generación N · Region" when `isShiny`, matching the existing "Álbum - Generación N · Region" format otherwise. Back-link behavior unchanged (`← Álbumes` always returns to the picker, both sections visible again).

## 5. Completion %

No change to `completion-percent.ts`. Each tile/heading now simply receives a pre-filtered subset (normal-only or shiny-only cards for that generation) instead of the mixed set, so `completionPercent(owned, total)` naturally reflects only that subset.

## Out of scope

- No backend/schema change — `generation` and shiny-detection (`splitCardName`) already exist client-side; this is a pure frontend split of an existing client-side grouping.
- No change to pack-opening odds or how shinies are drawn (`worker/lib/packs.ts` untouched).
- No change to `collection.html`'s flat owned-cards grid.
- No new page/route — still one `album.html`, parameterized.

## Verification

- No existing automated tests cover `src/album.ts` or `src/album-book.ts` (consistent with the rest of `src/*.ts` client code being untested today, per the precedent in `2026-07-03-generation-albums-design.md`).
- Manual in-browser: open `album.html`, confirm both grids render with correct independent %; open a normal album and confirm no shiny divider/pages appear; open each shiny album via its tile and confirm only shiny cards show, paginate through all spreads; confirm `?gen=N&shiny=1` and `?gen=N` deep-link correctly; confirm a generation with 0 owned shinies still shows its tile at 0%.
