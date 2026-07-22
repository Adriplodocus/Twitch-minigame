# Admin Panel Layout Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the admin panel (`admin.html`) into two functional columns — left: Buscar y dar sobres / Sobre de prueba / Configuración de sobres automáticos; right: Donaciones de PayPal sin asignar / Historial — and make it visually compact (smaller fonts/paddings), without changing the look of any other page.

**Architecture:** `#panel-view`'s `.admin-grid` (a 2-col grid that placed cards by DOM order, with `.span-2` cards breaking the flow) becomes `.admin-columns`, containing two explicit flex-column wrappers (`.admin-col-left`, `.admin-col-right`) so the 3 left cards and 2 right cards are grouped regardless of grid auto-placement. Compacting reuses the shared `.card`/`.btn`/`.input`/`h2` classes (so `admin.ts`'s dynamically-created elements need no changes) but overrides their padding/font-size only under the `#panel-view` selector prefix, so no other page is affected. The PayPal list and Historial table each get their own `max-height` + `overflow-y: auto` scroll region.

**Tech Stack:** Static HTML + hand-written CSS in `src/style.css` (no build step involved beyond Vite's existing CSS handling). No TypeScript changes.

## Global Constraints

- Desktop-first: mobile isn't a priority (90% of real usage is PC), but don't leave the layout literally broken below ~900px — a single cheap fallback media query is enough, no further mobile polish.
- Every compacted rule for a class shared with other pages (`.card`, `.btn`, `.input`, `h2`, `h3`, table `th`/`td`) must be scoped behind `#panel-view` so collection/trade/album/marketplace/overlay keep their current look.
- Classes only ever used in `admin.html` (`.cfg-columns`, `.cfg-column`, `.cfg-column-title`, `.cfg-label-text`, `.tp-columns`, `.admin-grid`/`.admin-columns`) can be edited directly — confirmed via `grep` that no other `.html` file references them.
- `admin.ts` is not touched — it hardcodes `.card`, `.btn`, `.input`, `.badge` for elements it creates dynamically (search results, donation rows), and those class names must keep working unchanged.
- Full design context: `docs/superpowers/specs/2026-07-22-admin-panel-layout-rework-design.md`.

---

### Task 1: Two-column HTML structure + compact scoped CSS

**Files:**
- Modify: `admin.html:47-202` (the `#panel-view` block)
- Modify: `src/style.css:55-66` (`.admin-grid`/`.span-2`), `src/style.css:68-112` (`.cfg-columns`/`.cfg-column`/`.tp-columns`/`.cfg-column-title`/`.cfg-label-text`)

**Interfaces:**
- Consumes: none new — every element id (`search-input`, `search-results`, `selected-user`, `grant-btn`, `test-pack-*`, `cfg-*`, `paypal-donations-list`, `history-body`) stays exactly as `src/admin.ts` already expects.
- Produces: no new IDs except the purely-visual `.history-table-wrap` div around the existing Historial `<table>` (no id needed on it — `admin.ts` only ever targets `#history-body`, the `<tbody>` inside).

- [ ] **Step 1: Rewrite the `#panel-view` markup in `admin.html`**

Replace the entire block from `<div id="panel-view" style="display: none;">`'s inner `<div class="admin-grid">` through its closing `</div>` (currently `admin.html:48-201`) with:

```html
        <div class="admin-columns">
          <div class="admin-col-left">
            <div class="card">
              <h2>Buscar y dar sobres</h2>
              <input
                class="input"
                id="search-input"
                placeholder="Buscar username de Twitch"
                style="margin-top: 0.75rem; width: 100%;"
              />
              <div id="search-results" style="margin-top: 0.5rem;"></div>

              <div id="selected-user" style="display: none; margin-top: 0.75rem; align-items: center; gap: 0.5rem;">
                <span class="badge" id="selected-user-name"></span>
                <button class="btn" id="clear-selection-btn" style="padding: 0.3rem 0.8rem;">x</button>
              </div>

              <div style="margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">
                <input class="input" id="quantity-input" type="number" min="1" max="50" value="1" style="width: 80px;" />
                <select class="input" id="tier-select">
                  <option value="gratis">Gratis</option>
                  <option value="apoyo">Apoyo</option>
                </select>
                <button class="btn" id="grant-btn" disabled>Dar blíster(s)</button>
              </div>
              <p id="grant-message" style="margin-top: 0.5rem;"></p>
            </div>

            <div class="card">
              <h2>Sobre de prueba</h2>
              <p style="margin-top: 0.25rem;">Abre un sobre sin tocar ninguna colección real; luego eliges si mandarlo al overlay.</p>
              <div style="margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <select class="input" id="test-pack-generation"></select>
                <select class="input" id="test-pack-tier">
                  <option value="gratis">Gratis</option>
                  <option value="apoyo">Apoyo</option>
                </select>
                <button class="btn" id="test-pack-btn">Abrir sobre de prueba</button>
              </div>
              <div class="tp-columns">
                <div class="cfg-column">
                  <h3 class="cfg-column-title">Normales</h3>
                  <label>
                    <span class="cfg-label-text">Common</span>
                    <input type="number" min="0" id="tp-common" value="0" class="input" />
                  </label>
                  <label>
                    <span class="cfg-label-text">Rare</span>
                    <input type="number" min="0" id="tp-rare" value="0" class="input" />
                  </label>
                  <label>
                    <span class="cfg-label-text">Epic</span>
                    <input type="number" min="0" id="tp-epic" value="0" class="input" />
                  </label>
                  <label>
                    <span class="cfg-label-text">Legendary</span>
                    <input type="number" min="0" id="tp-legendary" value="0" class="input" />
                  </label>
                </div>
                <div class="cfg-column">
                  <h3 class="cfg-column-title">Shiny</h3>
                  <label>
                    <span class="cfg-label-text">Common</span>
                    <input type="number" min="0" id="tp-shiny-common" value="0" class="input" />
                  </label>
                  <label>
                    <span class="cfg-label-text">Rare</span>
                    <input type="number" min="0" id="tp-shiny-rare" value="0" class="input" />
                  </label>
                  <label>
                    <span class="cfg-label-text">Epic</span>
                    <input type="number" min="0" id="tp-shiny-epic" value="0" class="input" />
                  </label>
                  <label>
                    <span class="cfg-label-text">Legendary</span>
                    <input type="number" min="0" id="tp-shiny-legendary" value="0" class="input" />
                  </label>
                </div>
              </div>
              <label style="display: flex; align-items: center; gap: 0.3rem; margin-top: 0.75rem;">Marcar como NEW
                <input type="number" min="0" max="10" id="tp-new-count" value="0" class="input" style="width: 3.5rem;" />
              </label>
              <p style="margin-top: 0.4rem; font-size: 0.78rem; color: var(--text);">Déjalo todo en 0 para probabilidades reales. Si rellenas alguna rareza, Common normal se autocompleta para sumar 10.</p>
              <p id="test-pack-message" style="margin-top: 0.5rem;"></p>
            </div>

            <div class="card">
              <h2>Configuración de sobres automáticos</h2>
              <div class="cfg-columns">
                <div class="cfg-column">
                  <h3 class="cfg-column-title">Puntos</h3>
                  <label>
                    <span class="cfg-label-text">Sobres por canje de puntos</span>
                    <input class="input" id="cfg-reward-quantity" type="number" min="0" max="1000" />
                  </label>
                </div>
                <div class="cfg-column">
                  <h3 class="cfg-column-title">Bits</h3>
                  <label>
                    <span class="cfg-label-text">Bits por sobre</span>
                    <input class="input" id="cfg-bits-threshold" type="number" min="1" max="1000" />
                  </label>
                  <label>
                    <span class="cfg-label-text">Sobres por umbral de bits</span>
                    <input class="input" id="cfg-bits-quantity" type="number" min="0" max="1000" />
                  </label>
                </div>
                <div class="cfg-column">
                  <h3 class="cfg-column-title">Suscripción</h3>
                  <label>
                    <span class="cfg-label-text">Sobres por suscripción/renovación</span>
                    <input class="input" id="cfg-sub-quantity" type="number" min="0" max="1000" />
                  </label>
                  <label>
                    <span class="cfg-label-text">Sobres por sub regalada</span>
                    <input class="input" id="cfg-gift-sub-multiplier" type="number" min="0" max="1000" />
                  </label>
                </div>
                <div class="cfg-column">
                  <h3 class="cfg-column-title">Paypal</h3>
                  <label>
                    <span class="cfg-label-text">€ por sobre (PayPal)</span>
                    <input class="input" id="cfg-paypal-threshold" type="number" min="1" max="1000" />
                  </label>
                  <label>
                    <span class="cfg-label-text">Sobres por umbral de PayPal</span>
                    <input class="input" id="cfg-paypal-quantity" type="number" min="0" max="1000" />
                  </label>
                </div>
              </div>
              <button class="btn" id="cfg-save-btn" style="margin-top: 0.75rem;">Guardar configuración</button>
              <p id="cfg-message" style="margin-top: 0.5rem;"></p>
            </div>
          </div>

          <div class="admin-col-right">
            <div class="card">
              <h2>Donaciones de PayPal sin asignar</h2>
              <div id="paypal-donations-list" style="margin-top: 0.75rem;"></div>
            </div>

            <div class="card">
              <h2>Historial</h2>
              <div class="history-table-wrap">
                <table style="width: 100%; border-collapse: collapse;">
                  <thead>
                    <tr>
                      <th style="text-align: left; padding: 0.4rem;">Usuario</th>
                      <th style="text-align: left; padding: 0.4rem;">Tier</th>
                      <th style="text-align: left; padding: 0.4rem;">Fuente</th>
                      <th style="text-align: left; padding: 0.4rem;">Fecha</th>
                      <th style="text-align: left; padding: 0.4rem;"></th>
                    </tr>
                  </thead>
                  <tbody id="history-body"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
```

- [ ] **Step 2: Replace `.admin-grid`/`.span-2` with `.admin-columns` in `src/style.css`**

Replace (`src/style.css:55-66`):

```css
.admin-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
  margin-top: 1.5rem;
}
@media (max-width: 700px) {
  .admin-grid { grid-template-columns: 1fr; }
}
.admin-grid .span-2 {
  grid-column: 1 / -1;
}
```

with:

```css
.admin-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
  margin-top: 1.5rem;
  align-items: start;
}
@media (max-width: 900px) {
  .admin-columns { grid-template-columns: 1fr; }
}
.admin-col-left, .admin-col-right {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
```

- [ ] **Step 3: Tighten `.cfg-columns`/`.cfg-column`/`.tp-columns`/`.cfg-column-title`/`.cfg-label-text` in `src/style.css`**

Replace (`src/style.css:68-112`):

```css
.cfg-columns {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1.25rem;
  margin-top: 0.75rem;
}
@media (max-width: 900px) {
  .cfg-columns { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 480px) {
  .cfg-columns { grid-template-columns: 1fr; }
}
.cfg-column {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.tp-columns {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.25rem;
  margin-top: 0.75rem;
  max-width: 420px;
}
.cfg-column-title {
  font-family: 'Quicksand', sans-serif;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
}
.cfg-column label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}
.cfg-label-text {
  display: flex;
  align-items: flex-end;
  min-height: 2.1rem;
  line-height: 1.2;
}
```

with (the left column is narrower now than the old full-width `.span-2` card, so `.cfg-columns` drops from 4 to 2 columns; both grids get smaller gaps/row-heights to read as compact):

```css
.cfg-columns {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;
  margin-top: 0.6rem;
}
@media (max-width: 480px) {
  .cfg-columns { grid-template-columns: 1fr; }
}
.cfg-column {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.tp-columns {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;
  margin-top: 0.6rem;
  max-width: 420px;
}
.cfg-column-title {
  font-family: 'Quicksand', sans-serif;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
}
.cfg-column label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.78rem;
}
.cfg-label-text {
  display: flex;
  align-items: flex-end;
  min-height: 1.6rem;
  line-height: 1.15;
}
```

- [ ] **Step 4: Add scoped `#panel-view` compact overrides + scroll boxes in `src/style.css`**

Add this new block right after the `.tp-columns`/`.cfg-column-title`/`.cfg-column label`/`.cfg-label-text` rules from Step 3 (i.e. still within the same area of the file, before the `.card { ... }` rule at the old line 114):

```css
#panel-view .card {
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
}
#panel-view h2 {
  font-size: 0.95rem;
  margin-bottom: 0.3rem;
}
#panel-view h3 {
  font-size: 0.8rem;
}
#panel-view p {
  font-size: 0.78rem;
}
#panel-view .btn {
  padding: 0.35rem 0.9rem;
  font-size: 0.78rem;
}
#panel-view .input {
  padding: 0.35rem 0.6rem;
  font-size: 0.78rem;
  border-radius: 8px;
}
#panel-view .badge {
  font-size: 0.6rem;
}
#panel-view table {
  font-size: 0.78rem;
}
#panel-view th,
#panel-view td {
  padding: 0.3rem 0.4rem;
}

#paypal-donations-list {
  max-height: 260px;
  overflow-y: auto;
}

.history-table-wrap {
  max-height: 420px;
  overflow-y: auto;
  margin-top: 0.75rem;
}
.history-table-wrap table {
  width: 100%;
  border-collapse: collapse;
}
.history-table-wrap thead th {
  position: sticky;
  top: 0;
  background: var(--surface);
}
```

- [ ] **Step 5: Type-check (no TS changed, but confirms nothing else broke) and start the dev server**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run dev`

- [ ] **Step 6: Manual verification**

1. Open `/admin.html`, log in.
2. Confirm the left column stacks Buscar y dar sobres → Sobre de prueba → Configuración de sobres automáticos, and the right column stacks Donaciones de PayPal sin asignar → Historial, both columns roughly similar width.
3. Confirm fonts/paddings read visibly smaller/denser than before, in the site's existing pink/gold/cream palette (no gray "generic dashboard" look).
4. If there are enough PayPal donations or history rows to overflow, confirm each scrolls independently inside its own card (not the whole page), and the Historial column header stays visible while scrolling.
5. Open `/collection.html` (or `/trade.html`) and confirm `.card`/`.btn`/`.input`/`h2` look exactly as before the change — the `#panel-view`-scoped overrides must not leak outside `admin.html`.

- [ ] **Step 7: Commit**

```bash
git add admin.html src/style.css
git commit -m "feat: rework admin panel into a compact two-column layout"
```
