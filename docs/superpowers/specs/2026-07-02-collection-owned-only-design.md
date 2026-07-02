# Collection page: owned cards only — design spec

## Goal

`collection.html` currently shows two sections: "Obtenidas" (owned cards) and
"Por conseguir" (unowned cards, grayscale). `album.html` already shows the
full catalog (owned + unowned) for browsing/completion tracking, making the
"Por conseguir" section on the collection page redundant. Remove it —
`collection.html` becomes owned-cards-only.

## Change

- `collection.html`: remove the `<h2 id="unowned-heading" ...>` element and
  the `<div id="unowned-grid" ...>` element.
- `src/collection.ts`: in `load()`, remove the `unowned` filter/variable and
  the two lines that set `unowned-heading`'s `innerHTML` and `unowned-grid`'s
  `innerHTML`. Everything else in `load()` (pending packs, `owned-heading`
  count, `renderOwnedGrid()`, sort controls) is unchanged.

## Out of scope

- No changes to `album.html`/`src/album.ts` (already does this job).
- No changes to the sort controls, pending-pack reveal flow, or the
  `owned-heading` "(X/Y)" progress count — that stays as-is.
- No changes to `worker/routes/collection.ts` or the `/api/collection`
  response shape — the API still returns all cards with `quantity`; the
  frontend simply stops rendering the unowned ones.
