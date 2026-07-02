# Cozy Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the 4 existing pages (index, album, collection, trade) from the current dark/neón look to a warm, cozy, friendly look, per `docs/superpowers/specs/2026-07-02-cozy-redesign-design.md`.

**Architecture:** Pure CSS/token-level restyle. No HTML structure changes, no new components, no new files. Three touch points: `src/style.css` (tokens + component rules), the font `<link>` in all 4 HTML files (add Quicksand), and one hardcoded overlay color in `src/collection.ts`.

**Tech Stack:** Vite, vanilla TS, plain CSS (no preprocessor/framework).

## Global Constraints

- No HTML structure changes to any page — restyle only (spec "Out of scope").
- No new pages, components, or files.
- Existing class names stay unchanged: `.card`, `.btn`, `.badge`, `.section-heading`, `.gender-icon`, `.shiny-icon`, `.card-qty`, `.info-btn`, `.info-tooltip`, `.card-grid`.
- JetBrains Mono stays only for `.card-qty` and `.section-heading .count`; everything else in the body moves to Quicksand. Russo One stays on `h1, h2, h3`.
- This project has no visual regression test suite — verification is manual via `npm run dev` in a browser, not automated tests.

---

### Task 1: Rewrite design tokens and component CSS in `src/style.css`

**Files:**
- Modify: `src/style.css` (entire file, 215 lines)

**Interfaces:**
- Consumes: nothing (pure CSS, no cross-file JS interface)
- Produces: CSS custom properties `--pink`, `--blue`, `--gold`, `--purple`, `--bg`, `--surface`, `--surface2`, `--border`, `--text`, `--text-em`, `--muted`, `--dim` — consumed by Task 3 (`src/collection.ts` overlay color references the warm palette conceptually, not via var) and by all 4 HTML files (no direct reference, just visual result).

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `src/style.css` with:

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --pink: #F2739E;
  --blue: #5AC8D8;
  --gold: #E8B93A;
  --purple: #B79AF0;

  --bg: #FAF3E6;
  --surface: #FFFFFF;
  --surface2: #F3E8D6;

  --border: rgba(120, 90, 60, 0.14);

  --text: #6E5C4C;
  --text-em: #3B2E22;
  --muted: #9C8874;
  --dim: #C9B79E;
}

html { background: #F3E8D6; font-size: 16px; }
@media (min-width: 700px) { html { font-size: 20px; } }

body {
  font-family: 'Quicksand', sans-serif;
  font-weight: 500;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

a { color: inherit; text-decoration: none; }
img { display: block; max-width: 100%; }

h1, h2, h3 { font-family: 'Russo One', sans-serif; color: var(--text-em); }
h1 { text-shadow: 0 2px 0 rgba(232, 185, 58, 0.25); }

.container {
  max-width: 860px;
  margin: 0 auto;
  padding: 0 1rem;
}

.card {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 1.15rem 1.4rem;
  box-shadow: 0 4px 16px rgba(120, 90, 60, 0.10);
  transition: transform 0.18s, box-shadow 0.18s;
}
.card:hover {
  transform: translateY(-4px);
  box-shadow: 0 10px 26px rgba(120, 90, 60, 0.18);
}
.card.unowned { opacity: 0.7; }
.card.unowned img { filter: grayscale(1) brightness(0.65); }

.card-art {
  width: 100%;
  aspect-ratio: 1;
  object-fit: contain;
  background: var(--surface2);
  border-radius: 14px;
}

.card-reveal { width: 140px; flex: 0 0 auto; }

.card.card-rarity-rare { border-color: var(--blue); }
.card.card-rarity-epic { border-color: var(--purple); }
.card.card-rarity-legendary { border-color: var(--gold); }

.card-name {
  margin-top: 0.5rem;
  color: var(--text-em);
  font-size: 0.6rem;
  font-weight: 700;
  line-height: 1.2;
  text-align: center;
  overflow-wrap: break-word;
}

.gender-icon {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 0.7rem;
  font-weight: 700;
  background: var(--surface2);
}
.gender-icon.gender-male { color: var(--blue); }
.gender-icon.gender-female { color: var(--pink); }
.shiny-icon {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  width: 26px;
  height: 26px;
  filter: drop-shadow(0 0 3px rgba(120, 90, 60, 0.35));
}
.card-footer {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.5rem;
  min-height: 1.1rem;
}
.card-footer-slot:empty { display: none; }
.card-footer-slot:last-child { margin-left: auto; }
.card-qty {
  padding: 0.15rem 0.55rem;
  border-radius: 100px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.6rem;
  font-weight: 600;
  color: var(--text-em);
  background: var(--surface2);
  white-space: nowrap;
}
.info-btn {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--surface2);
  color: var(--muted);
  font-family: 'Quicksand', sans-serif;
  font-size: 0.65rem;
  font-weight: 700;
  font-style: italic;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.info-btn:hover {
  border-color: var(--pink);
  color: var(--text-em);
}
.info-tooltip {
  display: none;
  position: absolute;
  bottom: 2.1rem;
  right: 0.5rem;
  z-index: 20;
  min-width: 130px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.5rem 0.65rem;
  box-shadow: 0 6px 20px rgba(120, 90, 60, 0.20);
  font-size: 0.6rem;
  line-height: 1.5;
  text-align: left;
  color: var(--text);
}
.info-tooltip.open { display: block; }
.info-tooltip p { margin: 0; }
.info-tooltip strong { color: var(--text-em); }

.section-heading {
  margin-top: 2rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text-em);
}
.section-heading .count {
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  font-weight: 600;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.7rem 1.6rem;
  border-radius: 100px;
  font-family: 'Quicksand', sans-serif;
  font-weight: 700;
  font-size: 0.9rem;
  background: var(--pink);
  color: #fff;
  border: none;
  box-shadow: 0 4px 14px rgba(242, 115, 158, 0.35);
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}
.btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(242, 115, 158, 0.45);
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.55rem;
  border-radius: 100px;
  font-size: 0.55rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: rgba(232, 185, 58, 0.18);
  color: #9C7A17;
  border: none;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 1rem;
  margin-top: 1.5rem;
}

.input {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.5rem 0.85rem;
  color: var(--text);
  font-family: 'Quicksand', sans-serif;
  font-size: 0.9rem;
  transition: border-color 0.18s;
  outline: none;
}
.input:focus { border-color: rgba(242, 115, 158, 0.5); }

@keyframes card-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
.card-in { animation: card-in 0.3s ease both; }
```

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: build succeeds with no errors (CSS is not type-checked, this only confirms Vite can process the file).

- [ ] **Step 3: Commit**

```bash
git add src/style.css
git commit -m "style: cozy redesign tokens and components"
```

---

### Task 2: Add Quicksand font to all 4 HTML entry points

**Files:**
- Modify: `index.html:9`
- Modify: `album.html:9`
- Modify: `collection.html:9`
- Modify: `trade.html:9`

**Interfaces:**
- Consumes: none
- Produces: `Quicksand` font family available for the `body` rule added in Task 1.

- [ ] **Step 1: Update the font link in each of the 4 files**

In each of `index.html`, `album.html`, `collection.html`, `trade.html`, replace this line:

```html
      href="https://fonts.googleapis.com/css2?family=Russo+One&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
```

with:

```html
      href="https://fonts.googleapis.com/css2?family=Russo+One&family=Quicksand:wght@500;700&family=JetBrains+Mono:wght@600&display=swap"
```

- [ ] **Step 2: Confirm all 4 files were updated**

Run: `grep -n "fonts.googleapis.com/css2" index.html album.html collection.html trade.html`
Expected: all 4 lines show `family=Quicksand:wght@500;700` present, no line still contains the old `JetBrains+Mono:wght@400;500;600;700` (without Quicksand).

- [ ] **Step 3: Commit**

```bash
git add index.html album.html collection.html trade.html
git commit -m "style: load Quicksand font for cozy redesign"
```

---

### Task 3: Warm the pack-reveal overlay color

**Files:**
- Modify: `src/collection.ts:69`

**Interfaces:**
- Consumes: none
- Produces: none (leaf change)

- [ ] **Step 1: Update the overlay background color**

In `src/collection.ts`, find line 69:

```ts
    "position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5rem; z-index: 10; padding: 1rem;";
```

Replace with:

```ts
    "position: fixed; inset: 0; background: rgba(59,46,34,0.80); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5rem; z-index: 10; padding: 1rem;";
```

- [ ] **Step 2: Confirm the change**

Run: `grep -n "background: rgba" src/collection.ts`
Expected: shows `rgba(59,46,34,0.80)`, no remaining `rgba(0,0,0,0.85)`.

- [ ] **Step 3: Commit**

```bash
git add src/collection.ts
git commit -m "style: warm pack-reveal overlay color"
```

---

### Task 4: Manual visual verification across all 4 pages

**Files:** none (verification only)

**Interfaces:**
- Consumes: the finished restyle from Tasks 1-3
- Produces: nothing further downstream — this is the final task

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: Vite prints a local URL (e.g. `http://localhost:5173`).

- [ ] **Step 2: Check `index.html` (login page)**

Open `/` in a browser. Confirm: cream background, Russo One title with subtle gold text-shadow, Quicksand body text, solid pink pill login button with soft shadow.

- [ ] **Step 3: Check `album.html`**

Navigate to `/album.html` (log in with a test Twitch account first if the route requires auth). Confirm: card grid uses cream cards with 20px radius, soft shadow, lift-on-hover; rarity borders show blue/purple/gold; unowned cards are grayscale+dimmed as before.

- [ ] **Step 4: Check `collection.html`, including the pack-reveal overlay and sort inputs**

Navigate to `/collection.html`. If a pending pack exists, open it and confirm the fullscreen reveal overlay is warm brown-tinted (`rgba(59,46,34,0.80)`), not pure black. Confirm the `#sort-field` and `#sort-direction` `<select>` elements now render as styled cream/white pills with `var(--border)` outline, not unstyled native dropdowns.

- [ ] **Step 5: Check `trade.html`**

Navigate to `/trade.html`. Confirm buttons, cards, and headings match the new cozy look; check the "Ofrece"/"Pide" muted-color text (`var(--muted)`) is legible on cream; confirm `#search-username` renders as a styled input with pink focus ring, not a bare native input.

- [ ] **Step 6: Confirm no leftover dark-theme artifacts**

Run: `grep -n "#1E1E1E\|#252525\|#2D2D2D\|#00CCFF\|#FF56B4\|#8B5CF6\|#FFD700" src/style.css src/collection.ts index.html album.html collection.html trade.html`
Expected: no matches (all old token values fully replaced).
