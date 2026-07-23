# Grayscale unowned cards in "cartas del otro usuario" grid

## Problem

`trade.ts` (used both for direct trade via `?with=` and marketplace-demand
responses via `?demandId=`) renders the target user's collection grid
(`target-collection`). Each card there is rendered with the target's own
`quantity`, so `renderCardHtml`'s ownership check (`card.quantity > 0`)
reflects whether the *target* owns the card — always true, since the grid
already filters out cards the target doesn't have. As a result every card in
that grid looks fully "owned" (color, foil, sparkle) regardless of whether
the viewer personally has it.

## Goal

In the target-collection grid, a card should render grayscale/unowned
(matching the existing `.unowned` styling used everywhere else) when the
*viewer* doesn't have that card, while still displaying the *target's* real
quantity in the badge — so the viewer can still see how many the other user
has to offer.

Scope: applies to every rendering of `target-collection` in `trade.ts`, for
both direct trades and marketplace-demand responses (same code path).

## Approach

Mirror the existing pattern in `marketplace.ts`'s `renderMarketplaceCard`,
which already builds a synthetic `CardView` with an overridden `quantity` to
drive `renderCardHtml`'s ownership/VFX logic, plus a separate explicit
`footerBadgeHtml` to show a different quantity than the one driving ownership.

In `trade.ts`:
- Track the viewer's own quantity per card id in a `Map<string, number>`,
  built once from `myCards` after collections load.
- In `renderSelectableCard`, when rendering the target grid (`inputClass ===
  "request-qty"`), build a display `CardView` copy whose `quantity` is the
  viewer's own quantity (0 if the viewer doesn't have it), and pass it to
  `renderCardHtml` instead of the original card.
- Pass the target's real quantity explicitly as `footerBadgeHtml` (reusing
  the existing `<span class="card-qty">x${card.quantity}</span>` markup) so
  the badge is unaffected by the ownership override.
- The `offer-qty` (viewer's own cards) grid and the `<input>` construction
  (which needs the target's real `max`) are untouched — only the object
  passed to `renderCardHtml` for the target grid changes.

No changes to `card.ts` or CSS: the existing `.unowned` grayscale/opacity
styling and foil/sparkle/tiltable suppression already do the right thing
once `quantity` reflects the viewer.

## Out of scope

- No change to which cards appear in the grid (still filtered to cards the
  target owns).
- No change to request quantity limits (still bounded by the target's real
  quantity).
