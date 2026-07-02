# Trade flow redesign

## Problem

`trade.html` today is a single hub: search box for an exact Twitch username, then
an offer builder (my cards + target cards, both full-size collection cards with
a raw number input), then a list of sent/received offers. Pain points:

- No way to discover who to trade with besides knowing their exact username.
- No search/sort inside the offer builder — finding a specific card among a full
  collection means scrolling.
- The offers list and the offer builder are crammed into one page.

Card size itself is fine and stays as-is (rejected during brainstorming: no
card-shrinking, no stepper redesign).

## Architecture

- `trade.html` stops being a browsable hub. It's only entered via
  `trade.html?with=<username>` (a link, not a page with its own search UI).
- `offers.html` (new): the "Ofertas" block (recibidas/enviadas, aceptar/
  rechazar/cancelar) moves here verbatim from `trade.ts`.
- `collection.html` and `album.html` each get two new buttons alongside the
  existing Volver/Cerrar sesión pair:
  - **Trade**: copies `${location.origin}/trade.html?with=<myUsername>` to the
    clipboard.
  - **Ofertas**: link to `/offers.html`.
- `GET /auth/me` starts returning `{ ok: true, username }` instead of just
  `{ ok: true }`, so the frontend has the username needed to build the share
  link without a new request.

No new backend routes, no schema changes. `GET /trade/users/:username`,
`POST /trade/offers`, and the accept/decline/cancel endpoints are reused as-is.

## `trade.html?with=<username>` page

Flow, top to bottom:

1. Header: "Intercambio con `<username>`" + standard nav (Volver a colección,
   Cerrar sesión).
2. **Panel 1 — "Cartas de `<username>`"**: a name-filter input only (no sort).
   Filtering is client-side over the already-fetched list (no backend calls).
   Grid reuses the existing `renderSelectableCard` (only cards with
   `quantity > 0` are shown, same as today).
3. **Panel 2 — "Tus cartas"**: sort controls identical to `collection.html`
   (field: Pokédex / Reciente / Cantidad, direction: asc/desc) plus a
   name-filter input. Same grid component.
4. "Enviar oferta" button, same behavior as today (`createOffer`).

Edge cases:

- No `with` param, or `getUserCollection` 404s → show an error panel, hide both
  grids and the send button.
- `with` equals the logged-in user's own username → show "No podés
  intercambiar con vos mismo", hide both grids and the send button.

### Shared sort logic

`compareCards` and the `SortField` type currently live in `collection.ts`.
Move them into `card.ts` so both `collection.ts` and `trade.ts` import the same
implementation instead of duplicating it.

### Name filter

Client-side only: filter the in-memory `CardView[]` array by
case-insensitive substring match against `card.name` (matches on the full
name, including variant suffixes like "Shiny"/"(Hembra)"), then re-render the
grid. No new query params, no extra round-trips.

## Copy-link behavior

- Primary path: `navigator.clipboard.writeText(...)`, then brief inline
  feedback (button label flips to "¡Copiado!" for ~1.5s).
- Fallback if the Clipboard API throws/unavailable: show the link in a
  `prompt()` (selectable, copyable by hand) instead of failing silently.

## Testing

- `test/routes/trade.test.ts`: no route changes expected; add/adjust coverage
  for `GET /auth/me` returning `username`.
- Manual: open a trade link across two accounts, filter both panels by name,
  sort own panel by each field, send an offer, accept it from `/offers.html`.

## Out of scope

- Card size/layout redesign (explicitly rejected).
- "Search by card, see who owns it" discovery mode (proposed, then dropped in
  favor of the share-link approach).
- Any change to trade acceptance/settlement logic in `worker/routes/trade.ts`.
