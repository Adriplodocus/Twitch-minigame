# Rarity VFX upgrade — design spec

## Goal

Rarity is currently signaled only by `border-color` on `.card` (rare=blue,
epic=purple, legendary=gold; common=none). This reads as weak. Add richer,
consistent VFX across every surface that renders a card, without touching
rarity weights, pack odds, or the DB schema — purely visual.

## Scope

All surfaces render cards through the single shared `renderCardHtml()` in
`src/card.ts`, consumed by `collection.ts`, `album-book.ts`, `trade.ts`, and
`offers.ts`. This is one implementation point — no per-page duplication.

VFX applies to **owned cards only** (`card.quantity > 0`). Unowned
(grayscale/dimmed) cards keep their current plain styling unchanged — the
effect is reserved as a visual reward for owning the card.

## Effects

### 1. Rarity foil (animated background)

- `common`: unchanged — no foil, plain surface, neutral border.
- `rare` / `epic` / `legendary`: animated diagonal gradient sheen in the
  rarity's color (blue / purple / gold), looping via `background-position`
  shift (ease-in-out; legendary cycles fastest and is most saturated).
  Border color stays as today — foil reinforces it, doesn't replace it.
- `legendary` additionally gets an ambient pulsing glow (`box-shadow`) layered
  on top of the foil.

### 2. 3D tilt + glare (hover interaction)

- Applies to any card carrying the foil treatment (rare/epic/legendary, and
  shiny commons — see below).
- Desktop/mouse only: gated behind `@media (hover: hover) and (pointer: fine)`.
  No touch/drag tilt — avoids fighting with scroll gestures on the album grid
  on mobile.
- Cursor position within the card drives `rotateX`/`rotateY` (±12deg) via
  `perspective(...) rotateX() rotateY() scale(1.04)`, plus a radial "glare"
  overlay that follows the cursor (`mix-blend-mode: overlay`). No transition
  while the pointer is moving (instant follow); a smooth transition eases the
  card back to flat on pointer-leave.

### 3. Shiny sparkle overlay

- Shiny cards (any rarity) get an extra layer on top of whatever foil is
  already there: a handful of small white dots at fixed positions, twinkling
  (opacity + scale pulse, staggered delays) on a loop.
- This is additive, not a replacement — rare/epic/legendary shinies keep
  their rarity-colored foil, with sparkles on top.
- `common` is the one special case: common alone has no foil. Shiny forces a
  subtle neutral/silver foil sheen as a base specifically for shiny commons
  (so the sparkle layer isn't sitting on flat white), and a neutral silver
  border instead of the default. Common shiny also gets the tilt/glare
  interaction, since it now carries a foil.

### 4. Reduced motion

- Respect `prefers-reduced-motion: reduce`: pause the foil shift, glow pulse,
  and sparkle twinkle animations, and skip the tilt/glare interaction
  entirely. Rarity is still visible via the (now static) foil color and
  border — nothing becomes invisible, just non-animated.

## Implementation notes

- `src/card.ts` `renderCardHtml()` already computes `isShiny` (via
  `splitCardName`) and already emits `card-rarity-${rarity}`. Add:
  - `foil` class when `rarity !== "common" || isShiny`
  - `shiny` class when `isShiny`
  - a `.glare` child div on any `foil` card
  - a `.sparkle-layer` child (with its dot spans) only when `isShiny`
- CSS additions live in `src/style.css`: `.foil.card-rarity-*` background/
  animation rules, `.foil.shiny.card-rarity-common` silver-base override,
  `.glare` / `.sparkle-layer` / `.dot` rules, and the tilt/glare rules scoped
  inside `@media (hover: hover) and (pointer: fine)`.
- Tilt/glare pointer tracking is a small new module (e.g. `src/card-tilt.ts`)
  using **delegated** `pointermove`/`pointerleave` listeners on a shared
  ancestor rather than per-card listeners — matches the existing delegation
  pattern already used for `.info-btn` in `card.ts`
  (`ensureInfoTooltipHandler`), and correctly handles cards that get
  re-rendered/replaced (collection re-sort, trade panel updates, etc.).
- No changes to `RARITY_WEIGHTS`, pack odds, or any table/column — this is
  CSS + one small JS enhancement module, no server/worker changes.

## Out of scope

- No change to which rarity a card belongs to, or shiny drop odds.
- No change to the info-tooltip, quantity badge, or card markup beyond the
  additions above.
- No new images/assets — all effects are CSS gradients/shadows plus a couple
  of `<span>` elements for sparkle dots.

## Prototype reference

Interactive comparison of foil/tilt/sparkle variants was built and approved
live in-browser during design (glow+shimmer vs. foil vs. particles vs. foil+
tilt+glare vs. shiny-rainbow-override vs. shiny-sparkle-overlay). Foil (B) +
tilt/glare + sparkle-overlay-on-top-of-foil was the approved direction.
