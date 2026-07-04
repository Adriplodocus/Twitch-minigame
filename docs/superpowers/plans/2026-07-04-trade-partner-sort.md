# Trade Partner Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sort controls (Pokédex / Recientes / Cantidad, Asc/Desc) to the partner's card grid in the Trade page, matching the sort already present on the user's own card grid.

**Architecture:** Reuse existing `compareCards`/`SortField` from `src/card.ts` (already used by `renderMyGrid`). Add a second, independent pair of `<select>` elements for the partner grid in `trade.html`, and extend `renderTargetGrid()` in `src/trade.ts` to sort after filtering, mirroring `renderMyGrid()`.

**Tech Stack:** TypeScript, Vite, vanilla DOM (no framework). No backend involved.

## Global Constraints

- No backend/API changes.
- No changes to `src/card.ts` (`compareCards`, `filterCardsByName` reused as-is) or `src/collection.ts`.
- Match existing sort option values/labels exactly: `pokedex`→"Pokédex", `recent`→"Recientes", `quantity`→"Cantidad"; `asc`→"Ascendente", `desc`→"Descendente".
- Project has no unit-test harness for `src/*.ts` frontend files (only `test/routes/*` backend tests exist) — verify this task manually in the browser, not via automated tests.

---

### Task 1: Partner grid sort controls

**Files:**
- Modify: `trade.html:44-52` (add selects near `#target-filter`, above `#target-collection`)
- Modify: `src/trade.ts:45-51` (`renderTargetGrid`), and the listener block at `src/trade.ts:133-139`

**Interfaces:**
- Consumes: `compareCards(a: CardView, b: CardView, field: SortField): number` and `type SortField = "pokedex" | "recent" | "quantity"` from `./card` (already imported in `src/trade.ts:3-10`). `filterCardsByName(cards: CardView[], query: string): CardView[]` (already imported, already used in `renderTargetGrid`).
- Produces: no new exports. New DOM element IDs `target-sort-field` and `target-sort-direction` are consumed only within `src/trade.ts`.

- [ ] **Step 1: Add sort selects to `trade.html`**

Replace this block:

```html
        <h2 id="target-heading">Cartas</h2>
        <input
          class="input"
          id="target-filter"
          placeholder="Buscar por nombre"
          style="margin-top: 0.75rem; width: 100%; max-width: 320px;"
        />
        <div id="target-collection" class="card-grid"></div>
```

with:

```html
        <h2 id="target-heading">Cartas</h2>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem;">
          <select id="target-sort-field" class="input">
            <option value="pokedex">Pokédex</option>
            <option value="recent">Recientes</option>
            <option value="quantity">Cantidad</option>
          </select>
          <select id="target-sort-direction" class="input">
            <option value="asc">Ascendente</option>
            <option value="desc">Descendente</option>
          </select>
          <input class="input" id="target-filter" placeholder="Buscar por nombre" style="flex: 1; min-width: 160px;" />
        </div>
        <div id="target-collection" class="card-grid"></div>
```

- [ ] **Step 2: Extend `renderTargetGrid` in `src/trade.ts` to sort**

Replace:

```ts
function renderTargetGrid(): void {
  const query = (document.getElementById("target-filter") as HTMLInputElement).value;
  const filtered = filterCardsByName(targetCards, query);
  document.getElementById("target-collection")!.innerHTML = filtered
    .map((c) => renderSelectableCard(c, "request-qty", requestQuantities, targetFemaleVariants, targetFormLabels))
    .join("");
}
```

with:

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

- [ ] **Step 3: Wire up change listeners**

Replace:

```ts
document.getElementById("target-filter")!.addEventListener("input", renderTargetGrid);
```

with:

```ts
document.getElementById("target-filter")!.addEventListener("input", renderTargetGrid);
document.getElementById("target-sort-field")!.addEventListener("change", renderTargetGrid);
document.getElementById("target-sort-direction")!.addEventListener("change", renderTargetGrid);
```

(Leave the rest of `src/trade.ts:134-139` unchanged.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual verification in browser**

Run: `npm run dev` (or the project's existing dev script), open the Trade page for a target user with 3+ distinct cards of varying quantity/pokedex order.

Verify:
- Partner grid shows the two new selects, defaulting to Pokédex/Ascendente, matching "Tus cartas" styling.
- Changing partner sort field/direction reorders the partner grid only — "Tus cartas" grid and its own sort controls are unaffected.
- Typing in the partner name filter still narrows the partner grid, combined correctly with the current sort (filter-then-sort, same as the existing "Tus cartas" behavior).
- No console errors.

- [ ] **Step 6: Commit**

```bash
git add trade.html src/trade.ts
git commit -m "feat: add sort to trade partner card grid"
```
