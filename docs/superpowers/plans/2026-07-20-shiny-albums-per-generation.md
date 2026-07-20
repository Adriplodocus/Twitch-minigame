# Shiny Albums Per Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split shiny cards out of each generation's normal album into their own dedicated per-generation shiny album, reachable from a second section on the album picker page.

**Architecture:** Pure frontend change to `src/album.ts`, `src/album-book.ts`, `album.html`, `src/style.css`. `album.ts` filters the already-fetched `/api/collection` payload into normal/shiny subsets before handing cards to the picker-tile renderer or to `AlbumBook`; `album-book.ts` no longer needs to know about shiny at all — the divider-page concept it currently has is deleted since a book is now always single-type.

**Tech Stack:** Vanilla TypeScript, Vite multi-page build, no framework, no backend/schema changes.

## Global Constraints

- No backend/schema changes — `generation` field and `splitCardName().isShiny` already exist client-side (spec section: Out of scope).
- No automated tests exist for `src/album.ts` / `src/album-book.ts` today (consistent with the rest of `src/*.ts` client code) — verification here is manual in-browser, per `docs/superpowers/specs/2026-07-20-shiny-albums-per-generation-design.md`.
- Typecheck via `npx tsc --noEmit -p tsconfig.app.json` after every code change (covers `src/`).
- Shiny badge reuses the existing `/shiny-icon.webp` asset (already used in `src/card.ts:174`) — no new image assets.
- Gold accent for shiny tiles uses `#FFD700` (the "Gold / Milestone" state color from the house design system) — not a new arbitrary color.

---

### Task 1: Split normal/shiny into separate books and picker sections

**Files:**
- Modify: `src/album-book.ts` (remove divider concept, `buildPages` becomes filter-free)
- Modify: `album.html` (add shiny picker heading + grid elements)
- Modify: `src/album.ts` (picker renders two sections, book filters by `shiny` query param)

**Interfaces:**
- Consumes: `CardView` (`src/api.ts`, has `generation: number`, `name: string`, `quantity: number`), `splitCardName` and `renderCardHtml` (`src/card.ts`), `GENERATIONS` (`src/generations.ts`), `completionPercent` (`src/completion-percent.ts`).
- Produces: `AlbumBook` (`src/album-book.ts`) constructor keeps signature `new AlbumBook(cards: CardView[], deps: BookDeps)` — callers must now pass already shiny-filtered `cards`. `buildPages(cards: CardView[]): BookPage[]` where `BookPage = (CardView | null)[]` (type simplified, no more `{kind, ...}` wrapper).

- [ ] **Step 1: Simplify `album-book.ts` — remove the divider concept**

Replace the `BookPage` type and `buildPages` function (currently `src/album-book.ts:32-51`):

```typescript
type BookPage = (CardView | null)[];

function buildPages(cards: CardView[]): BookPage[] {
  const sorted = [...cards].sort((a, b) => albumSortKey(a) - albumSortKey(b));
  const pages: BookPage[] = chunkIntoPages(sorted);
  if (pages.length % PAGES_PER_SPREAD !== 0) pages.push(new Array(PAGE_SIZE).fill(null));
  return pages;
}
```

Remove the now-stale comment above the old `buildPages` (the one starting "Shinies are pulled out of dex order...", `src/album-book.ts:34-36`) — delete it, it no longer describes any behavior in this file.

Also remove the now-unused `splitCardName` import (`src/album-book.ts:2` currently imports `{ renderCardHtml, splitCardName }` — drop `splitCardName`, keep `renderCardHtml`).

Update `renderPageHtml` (currently `src/album-book.ts:105-117`) to drop the divider branch:

```typescript
  private renderPageHtml(pageIndex: number): string {
    const page = this.pages[pageIndex];
    return `<div class="book-page">${page
      .map((c) =>
        c
          ? renderCardHtml(c, "", this.deps.femaleVariantBaseNames, this.deps.formLabels)
          : `<div class="book-page-slot-empty"></div>`
      )
      .join("")}</div>`;
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: fails right now with errors in `src/album.ts` (the `AlbumBook` call site hasn't been updated yet) — that's expected at this point in the task. If it fails with an error *inside* `album-book.ts` itself, fix that before moving on.

- [ ] **Step 3: Add shiny picker section markup to `album.html`**

In `album.html`, find:

```html
      <div id="album-picker">
        <h2 id="picker-heading" class="section-heading"></h2>
        <div id="album-picker-grid" class="album-picker-grid"></div>
      </div>
```

Replace with:

```html
      <div id="album-picker">
        <h2 id="picker-heading" class="section-heading"></h2>
        <div id="album-picker-grid" class="album-picker-grid"></div>
        <h3 id="picker-heading-shiny" class="section-heading"></h3>
        <div id="album-picker-grid-shiny" class="album-picker-grid"></div>
      </div>
```

- [ ] **Step 4: Rewrite `album.ts` picker + book rendering**

Replace the full contents of `src/album.ts` with:

```typescript
import { getCollection, type CardView } from "./api";
import { collectFemaleVariantBaseNames, computeFormLabels, splitCardName } from "./card";
import { attachTradeLinkButton } from "./trade-link";
import { initUserHeader } from "./user-header";
import { GENERATIONS, type GenerationInfo } from "./generations";
import { AlbumBook } from "./album-book";
import { completionPercent } from "./completion-percent";

function renderGenTile(gen: GenerationInfo, genCards: CardView[], isShiny: boolean): string {
  const genOwned = genCards.filter((c) => c.quantity > 0).length;
  const shinyParam = isShiny ? "&shiny=1" : "";
  const shinyBadge = isShiny ? `<img class="album-cover-shiny-badge" src="/shiny-icon.webp" alt="" />` : "";
  return `
    <a class="album-cover${isShiny ? " album-cover-shiny" : ""}" href="/album.html?gen=${gen.id}${shinyParam}">
      <img class="album-cover-bg" src="/album-covers/${gen.id}.webp" alt="" />
      <span class="album-cover-overlay"></span>
      ${shinyBadge}
      <span class="album-cover-content">
        <p class="album-cover-gen">
          <span class="album-cover-gen-label">Generación</span>
          <span class="album-cover-gen-number">${gen.id}</span>
        </p>
        <p class="album-cover-region">${gen.region}</p>
        <span class="album-cover-count">${genOwned}/${genCards.length} · ${completionPercent(genOwned, genCards.length)}%</span>
      </span>
    </a>
  `;
}

function renderPicker(cards: CardView[]): void {
  const normalCards = cards.filter((c) => !splitCardName(c.name).isShiny);
  const shinyCards = cards.filter((c) => splitCardName(c.name).isShiny);

  const owned = normalCards.filter((c) => c.quantity > 0).length;
  document.getElementById("picker-heading")!.innerHTML =
    `Elige un álbum <span class="count">(${owned}/${normalCards.length} · ${completionPercent(owned, normalCards.length)}%)</span>`;
  document.getElementById("album-picker-grid")!.innerHTML = GENERATIONS.map((gen) =>
    renderGenTile(gen, normalCards.filter((c) => c.generation === gen.id), false)
  ).join("");

  const shinyOwned = shinyCards.filter((c) => c.quantity > 0).length;
  document.getElementById("picker-heading-shiny")!.innerHTML =
    `Shiny <span class="count">(${shinyOwned}/${shinyCards.length} · ${completionPercent(shinyOwned, shinyCards.length)}%)</span>`;
  document.getElementById("album-picker-grid-shiny")!.innerHTML = GENERATIONS.map((gen) =>
    renderGenTile(gen, shinyCards.filter((c) => c.generation === gen.id), true)
  ).join("");
}

function renderBook(
  cards: CardView[],
  gen: number,
  isShiny: boolean,
  femaleVariantBaseNames: Set<string>,
  formLabels: Map<string, string>
): void {
  const genInfo = GENERATIONS.find((g) => g.id === gen)!;
  const genCards = cards.filter((c) => c.generation === gen && splitCardName(c.name).isShiny === isShiny);
  const owned = genCards.filter((c) => c.quantity > 0).length;
  const title = isShiny ? "Álbum Shiny" : "Álbum";
  document.getElementById("book-heading")!.innerHTML =
    `${title} - Generación ${genInfo.id} · ${genInfo.region} <span class="count">(${owned}/${genCards.length} · ${completionPercent(owned, genCards.length)}%)</span>`;

  new AlbumBook(genCards, {
    spreadEl: document.getElementById("book-spread")!,
    firstBtn: document.getElementById("book-first") as HTMLButtonElement,
    prevBtn: document.getElementById("book-prev") as HTMLButtonElement,
    nextBtn: document.getElementById("book-next") as HTMLButtonElement,
    lastBtn: document.getElementById("book-last") as HTMLButtonElement,
    indicatorEl: document.getElementById("book-indicator")!,
    flipSound: document.getElementById("page-flip-sound") as HTMLAudioElement,
    femaleVariantBaseNames,
    formLabels,
  });
}

function parseGenParam(): number | null {
  const params = new URLSearchParams(window.location.search);
  const gen = Number(params.get("gen"));
  return Number.isInteger(gen) && gen >= 1 && gen <= 9 ? gen : null;
}

function parseShinyParam(): boolean {
  return new URLSearchParams(window.location.search).get("shiny") === "1";
}

async function load(): Promise<void> {
  const data = await getCollection();
  const femaleVariantBaseNames = collectFemaleVariantBaseNames(data.cards);
  const formLabels = computeFormLabels(data.cards);
  const gen = parseGenParam();
  const isShiny = parseShinyParam();

  const pickerEl = document.getElementById("album-picker")!;
  const bookEl = document.getElementById("album-book")!;

  if (gen === null) {
    pickerEl.style.display = "";
    bookEl.style.display = "none";
    renderPicker(data.cards);
  } else {
    pickerEl.style.display = "none";
    bookEl.style.display = "";
    renderBook(data.cards, gen, isShiny, femaleVariantBaseNames, formLabels);
  }
}

attachTradeLinkButton("trade-link-btn");
initUserHeader();

load();
```

Note: `GenerationInfo` must be exported from `src/generations.ts` for this import to typecheck — check `src/generations.ts:1-4`; it's already `export interface GenerationInfo`, so no change needed there.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Run: `npm run dev`, open `http://localhost:5173/album.html` (adjust port if Vite picks a different one) in a browser, logged in as a user with some owned cards (normal and shiny).

Check:
1. Picker shows the existing 9-tile normal grid, then a "Shiny" heading, then a second 9-tile grid below it.
2. Each normal tile's `owned/total · %` reflects only non-shiny cards for that generation (compare against a generation you know has shinies — the total should be lower than before this change, since shinies no longer count).
3. Each shiny tile's `owned/total · %` reflects only shiny cards for that generation; a generation with 0 owned shinies still shows a tile at `0/N · 0%`, not hidden.
4. Click a normal-gen tile → book shows only non-shiny cards, no "Shiny" divider page anywhere, heading reads "Álbum - Generación N · Region".
5. Go back, click the matching shiny-gen tile → URL is `/album.html?gen=N&shiny=1`, book shows only shiny cards for that generation, heading reads "Álbum Shiny - Generación N · Region".
6. Paginate through a shiny book with more than 16 shiny cards (if you have one) to confirm multi-page/spread navigation still works with the simplified `buildPages`.

- [ ] **Step 7: Commit**

```bash
git add src/album-book.ts album.html src/album.ts
git commit -m "feat: split shiny cards into per-generation albums"
```

---

### Task 2: Shiny tile visual treatment + divider CSS cleanup

**Files:**
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `.album-cover-shiny` and `.album-cover-shiny-badge` classes produced by Task 1's `renderGenTile` in `src/album.ts`.
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Remove the now-unused divider CSS**

In `src/style.css`, delete the `.book-page-divider` / `.book-page-divider-label` block (currently `src/style.css:1195-1207`):

```css
.book-page-divider {
  display: flex;
  align-items: center;
  justify-content: center;
}
.book-page-divider-label {
  font-family: 'Russo One', sans-serif;
  font-size: 2.25rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-em);
  text-shadow: 0 0 20px rgba(255, 86, 180, 0.5), 0 0 40px rgba(0, 204, 255, 0.2);
}
```

Delete the whole block including its surrounding blank lines so you don't leave a double blank gap.

- [ ] **Step 2: Add shiny tile styling**

In `src/style.css`, right after the existing `.album-cover-count` rule (currently ends around `src/style.css:1136`), add:

```css
.album-cover-shiny {
  border-color: rgba(255, 215, 0, 0.35);
  box-shadow: 0 4px 16px rgba(120, 90, 60, 0.10), 0 0 20px rgba(255, 215, 0, 0.12);
}
.album-cover-shiny:hover {
  box-shadow: 0 10px 26px rgba(120, 90, 60, 0.18), 0 0 24px rgba(255, 215, 0, 0.24);
}
.album-cover-shiny-badge {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 2;
  width: 28px;
  height: 28px;
  filter: drop-shadow(0 0 4px rgba(255, 215, 0, 0.6));
}
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, open `/album.html`.

Check:
1. The 9 shiny tiles have a visible gold-tinted border/glow distinguishing them from the normal tiles, plus a small sparkle badge in the top-left corner of each shiny tile.
2. Normal tiles are unchanged from before this task.
3. Open dev tools, confirm no CSS errors/warnings referencing `book-page-divider`.

- [ ] **Step 4: Commit**

```bash
git add src/style.css
git commit -m "style: visually distinguish shiny album tiles"
```

---

## Rollout

Frontend-only change — `npm run deploy` (build + `wrangler deploy`) after both tasks land. No migration, no D1 changes, no worker route changes.
