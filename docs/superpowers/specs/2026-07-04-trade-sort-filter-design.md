# Trade: sort partner cards — design

## Problem

Trade page (`trade.html` / `src/trade.ts`) already supports:
- Name filter on both grids (partner's cards `target-collection`, own cards `my-cards`) via `filterCardsByName`.
- Sort (Pokédex / Recientes / Cantidad, Asc/Desc) on own cards grid only, via `compareCards` + `#sort-field` / `#sort-direction`.

Partner's cards grid has no sort controls. User wants sort parity with the collection page on both grids in trade.

## Design

Add a second, independent pair of sort selects for the partner grid.

### `trade.html`

Above `#target-collection`, alongside the existing `#target-filter` input, add:

```html
<select id="target-sort-field" class="input">
  <option value="pokedex">Pokédex</option>
  <option value="recent">Recientes</option>
  <option value="quantity">Cantidad</option>
</select>
<select id="target-sort-direction" class="input">
  <option value="asc">Ascendente</option>
  <option value="desc">Descendente</option>
</select>
```

Same markup/options as the existing `#sort-field` / `#sort-direction` pair used for "Tus cartas".

### `src/trade.ts`

`renderTargetGrid()` currently only filters. Extend it to also sort, mirroring `renderMyGrid()`:

```ts
function renderTargetGrid(): void {
  const field = (document.getElementById("target-sort-field") as HTMLSelectElement).value as SortField;
  const direction = (document.getElementById("target-sort-direction") as HTMLSelectElement).value;
  const sign = direction === "desc" ? -1 : 1;
  const query = (document.getElementById("target-filter") as HTMLInputElement).value;
  const filtered = filterCardsByName(targetCards, query).sort((a, b) => compareCards(a, b, field) * sign);
  document.getElementById("target-collection")!.innerHTML = filtered
    .map((c) => renderSelectableCard(c, "request-qty", requestQuantities, targetFemaleVariants, targetFormLabels))
    .join("");
}
```

Add `change` listeners on the two new selects calling `renderTargetGrid`, same pattern as the existing `sort-field`/`sort-direction` listeners for `renderMyGrid`.

No backend changes. No changes to `collection.ts` (already has sort) or `card.ts` (`compareCards`/`filterCardsByName` reused as-is).

## Testing

Manual: load trade page with a partner that has multiple cards, change partner sort field/direction, confirm order changes and combines correctly with the name filter (filter then sort, same as own-cards grid).
