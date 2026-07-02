# Pack-open image button — design spec

## Goal

Replace the text `<button class="btn">Abrir sobre</button>` used to open pending packs with a clickable pack-artwork image, keeping identical open/reveal behavior.

## Current state

`src/collection.ts`'s `renderPendingPacks()` renders one `<button class="btn">` per pending pack (label `"Abrir sobre"` or `"Abrir sobre N"` when there's more than one), with a click handler that disables the button, swaps its text to `"Abriendo..."`, calls `onOpen(pack.id)`, and restores the label when done.

## New behavior

- Each pending pack renders as a clickable `<img>` instead of a `<button>`, one image per pending pack (same 1:1 mapping as today — if there are 3 pending packs, 3 clickable images appear).
- No visible number/label on the image (the artwork is self-explanatory as "a pack to open"); the existing `"Abrir sobre 1/2/3"` numbering is dropped.
- Image source: `/pack.png`, a static asset the user will provide and drop into `public/pack.png`. The code references this path; no image is generated or designed as part of this work.
- Click behavior is otherwise identical to today's button: on click, the image becomes non-interactive (`pointer-events: none` + reduced opacity, replacing the old `disabled` + "Abriendo..." text swap, since an image has no text label to swap), calls `onOpen(pack.id)`, and restores interactivity when the promise settles (whether it succeeds or fails, matching the current `.finally()` behavior).
- Sizing: `140px` wide (matches `.card-reveal` and the card grid's `minmax(140px, 1fr)` column width, per the existing design system, for visual consistency with the rest of the collection page).
- Hover: reuse the existing cozy-redesign lift pattern already defined for `.card` in `src/style.css` (`transform: translateY(-4px)` + soft shadow on hover) so the pack image reads as interactive, consistent with how cards already behave.

## Files touched

- `src/collection.ts` — `renderPendingPacks()` rewritten to create `<img>` elements instead of `<button>` elements.
- `src/style.css` — new `.pack-open-img` class: `width: 140px`, `cursor: pointer`, base + hover styles reusing the `.card` hover pattern (lift + soft shadow), plus a disabled/opening state (reduced opacity, `pointer-events: none`).
- `public/pack.png` — NOT created by this work; the user supplies this file separately. Until it exists, the browser will show a broken-image icon, which is expected and out of scope to fix here.

## Out of scope

- No change to `openPack`/`revealPack`/the reveal animation itself.
- No change to how multiple pending packs are counted or fetched (`data.pendingPacks` from the API is unchanged).
- No new pack artwork is designed, generated, or sourced by this work — purely wiring the existing `renderPendingPacks()` to reference an image path instead of rendering a text button.
- No accessibility text (e.g. `alt`) requirements beyond a plain descriptive `alt="Abrir sobre"` on the `<img>` for screen readers, since the visible numbered label is being removed.

## Verification

- `npm run dev`, visually confirm: with 0/1/3 pending packs (seed test data or existing account state), the correct number of pack images render, each clickable, each independently entering an "opening" (dimmed, unclickable) state and calling the existing open/reveal flow correctly on click.
- No automated test changes expected — this is a DOM-rendering change with no existing test coverage for `renderPendingPacks` (confirmed: no `collection.test.ts` under `test/` covers the frontend `src/collection.ts` file, only the backend route `worker/routes/collection.ts`).
