# Rarity VFX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the border-only rarity indicator with an animated foil background (rare/epic/legendary), a mouse-driven 3D tilt+glare hover effect, and a shiny sparkle overlay — applied consistently everywhere `.card` is rendered, owned cards only.

**Architecture:** All card markup already flows through one function, `renderCardHtml()` in `src/card.ts`, consumed unchanged by `collection.ts`, `album-book.ts`, `trade.ts`, and `offers.ts`. Add the new classes/markup there once. CSS-only foil/sparkle visuals go in `src/style.css`. The pointer-driven tilt/glare interaction is a new delegated-listener module, `src/card-tilt.ts`, following the same lazy-singleton delegation pattern `card.ts` already uses for its info-tooltip handler (`ensureInfoTooltipHandler`).

**Tech Stack:** Vanilla TypeScript (no framework), plain CSS, Vitest for unit tests.

## Global Constraints

- VFX (foil background, tilt/glare, sparkle overlay) applies **only to owned cards** (`card.quantity > 0`). Unowned/grayscale cards are visually unchanged.
- `common` rarity gets no foil unless the card is also shiny.
- Rarity border colors (blue/purple/gold) are unchanged — foil/sparkle are additive, never replace the border-based rarity cue.
- Tilt/glare interaction is gated to `@media (hover: hover) and (pointer: fine)` — no touch/tap tilt.
- `prefers-reduced-motion: reduce` pauses all new animations (foil shift, glow pulse, sparkle twinkle) and disables the tilt/glare interaction entirely; rarity stays visible via the (now static) foil color and border.
- No changes to rarity weights, pack odds, or any DB/worker code — this is a `src/` (frontend) + CSS-only change.

---

### Task 1: Add foil/shiny classes and overlay markup to `renderCardHtml`

**Files:**
- Modify: `src/card.ts:113-161` (`renderCardHtml`)
- Modify: `vitest.config.ts` (broaden `include` to pick up the new test file)
- Test: `src/card.test.ts` (new)

**Interfaces:**
- Consumes: `CardView` from `src/api.ts` (`{ id, name, rarity: "common"|"rare"|"epic"|"legendary", imagePath, quantity, generation, sortOrder?, acquiredAt? }`), `splitCardName(name)` (existing, returns `{ baseName, variantLabel, isShiny, isFemale }`).
- Produces: `renderCardHtml(card, innerExtra?, femaleVariantBaseNames?, formLabels?): string` — same signature as today, unchanged callers. New CSS classes on the root `.card` element: `foil` (present when owned and `rarity !== "common" || isShiny`), `shiny` (present when owned and `isShiny`). New child markup: `<div class="glare"></div>` when `foil` is present; a `.sparkle-layer` with 6 `.dot` spans when `shiny` is present. Task 2 depends on these exact class/element names.

- [ ] **Step 1: Write the failing tests**

Create `src/card.test.ts`:

```ts
import { it, expect } from "vitest";
import { renderCardHtml } from "./card";
import type { CardView } from "./api";

function card(overrides: Partial<CardView> = {}): CardView {
  return {
    id: "p1",
    name: "Bulbasaur",
    rarity: "common",
    imagePath: "/p1.png",
    quantity: 1,
    generation: 1,
    ...overrides,
  };
}

it("owned common non-shiny gets no foil, no shiny, no overlay markup", () => {
  const html = renderCardHtml(card());
  expect(html).not.toMatch(/class="card [^"]*\bfoil\b/);
  expect(html).not.toContain('class="glare"');
  expect(html).not.toContain('class="sparkle-layer"');
});

it("owned rare non-shiny gets foil and a glare layer, but no shiny class/sparkles", () => {
  const html = renderCardHtml(card({ rarity: "rare" }));
  expect(html).toMatch(/class="card card-rarity-rare foil/);
  expect(html).toContain('class="glare"');
  expect(html).not.toContain('class="sparkle-layer"');
});

it("owned common shiny gets foil, shiny, glare, and sparkle layer", () => {
  const html = renderCardHtml(card({ name: "Bulbasaur Shiny" }));
  expect(html).toMatch(/class="card card-rarity-common foil shiny/);
  expect(html).toContain('class="glare"');
  const dotCount = (html.match(/class="dot"/g) ?? []).length;
  expect(dotCount).toBe(6);
});

it("owned legendary shiny gets foil, shiny, glare, and sparkle layer", () => {
  const html = renderCardHtml(card({ name: "Mewtwo Shiny", rarity: "legendary" }));
  expect(html).toMatch(/class="card card-rarity-legendary foil shiny/);
  expect(html).toContain('class="sparkle-layer"');
});

it("unowned rare card gets no foil even though rarity qualifies", () => {
  const html = renderCardHtml(card({ rarity: "rare", quantity: 0 }));
  expect(html).not.toMatch(/\bfoil\b/);
  expect(html).toContain("unowned");
});

it("unowned shiny card gets no foil/shiny/sparkle either", () => {
  const html = renderCardHtml(card({ name: "Bulbasaur Shiny", quantity: 0 }));
  expect(html).not.toMatch(/\bfoil\b/);
  expect(html).not.toMatch(/\bshiny\b/);
  expect(html).not.toContain('class="sparkle-layer"');
});
```

- [ ] **Step 2: Broaden the Vitest include so this new test file runs**

Edit `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tools/**/*.test.ts", "src/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/card.test.ts` assertions fail because `renderCardHtml` doesn't emit `foil`/`shiny`/`.glare`/`.sparkle-layer` yet (the `card-rarity-rare foil` etc. patterns won't match the current plain `card-rarity-rare ` output).

- [ ] **Step 4: Implement the class/markup logic**

In `src/card.ts`, replace the body of `renderCardHtml` from the `const ownedClass = ...` line through the final `return` (currently `src/card.ts:121-161`) with:

```ts
  const isOwned = card.quantity > 0;
  const ownedClass = isOwned ? "" : "unowned";
  const { baseName: fullBaseName, isShiny, isFemale } = splitCardName(card.name);
  const formLabel = formLabels?.get(card.id);
  const baseName = formLabel ? fullBaseName.slice(0, -(formLabel.length + 1)) : fullBaseName;
  const hasFemaleVariant = isFemale || (femaleVariantBaseNames?.has(fullBaseName) ?? false);
  const genderIcon = isFemale
    ? `<span class="gender-icon gender-female">♀</span>`
    : hasFemaleVariant
      ? `<span class="gender-icon gender-male">♂</span>`
      : "";
  const shinyIcon = isShiny ? `<img class="shiny-icon" src="/shiny-icon.webp" alt="Shiny" />` : "";
  const qtyBadge = card.quantity > 0 ? `<span class="card-qty">x${card.quantity}</span>` : "";

  const hasFoil = isOwned && (card.rarity !== "common" || isShiny);
  const hasSparkle = isOwned && isShiny;
  const vfxClasses = `${hasFoil ? " foil" : ""}${hasSparkle ? " shiny" : ""}`;
  const glareHtml = hasFoil ? `<div class="glare"></div>` : "";
  const sparkleHtml = hasSparkle
    ? `<div class="sparkle-layer">${"<span class=\"dot\"></span>".repeat(6)}</div>`
    : "";

  const genderLine = isFemale ? "Hembra" : hasFemaleVariant ? "Macho" : null;
  const infoTooltip = `
    <div class="info-tooltip">
      <p><strong>${baseName}</strong></p>
      ${formLabel ? `<p>Variante: ${formLabel}</p>` : ""}
      <p>Rareza: ${RARITY_LABELS[card.rarity]}</p>
      ${isShiny ? `<p>Shiny: Sí</p>` : ""}
      ${genderLine ? `<p>Género: ${genderLine}</p>` : ""}
    </div>
  `;

  return `
    <div class="card card-rarity-${card.rarity}${vfxClasses} ${ownedClass} card-in">
      ${glareHtml}
      ${sparkleHtml}
      ${genderIcon}
      ${shinyIcon}
      <img class="card-art" src="${card.imagePath}" alt="${baseName}" loading="lazy" />
      <p class="card-name">${baseName}</p>
      <div class="card-footer">
        <span class="card-footer-slot">${qtyBadge}</span>
        <span class="card-footer-slot">
          <button type="button" class="info-btn" aria-label="Info">i</button>
        </span>
      </div>
      ${infoTooltip}
      ${innerExtra}
    </div>
  `;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all 6 new tests in `src/card.test.ts` green, plus the existing `tools/**/*.test.ts` tests still passing.

- [ ] **Step 6: Commit**

```bash
git add src/card.ts src/card.test.ts vitest.config.ts
git commit -m "feat: add foil/shiny VFX classes to card markup"
```

---

### Task 2: Foil background, shiny overlay, and reduced-motion CSS

**Files:**
- Modify: `src/style.css:100-102` (existing rarity border rules) and the surrounding area

**Interfaces:**
- Consumes: the `.foil`, `.shiny`, `.glare`, `.sparkle-layer`, `.dot` classes/elements produced by Task 1.
- Produces: visual foil backgrounds keyed on `.card.foil.card-rarity-{rare,epic,legendary}` and `.card.foil.shiny.card-rarity-common`; base (non-interactive) appearance for `.glare` and `.sparkle-layer` — Task 3 adds the `.tilting` state and pointer-driven inline styles on top of these.

- [ ] **Step 1: Replace the existing rarity border block with foil rules**

In `src/style.css`, replace:

```css
.card.card-rarity-rare { border-color: var(--blue); }
.card.card-rarity-epic { border-color: var(--purple); }
.card.card-rarity-legendary { border-color: var(--gold); }
```

with:

```css
.card.card-rarity-rare { border-color: var(--blue); }
.card.card-rarity-epic { border-color: var(--purple); }
.card.card-rarity-legendary { border-color: var(--gold); }

.card.foil.card-rarity-rare {
  background: linear-gradient(115deg, var(--surface) 20%, #d8f3f7 40%, var(--surface) 60%);
  background-size: 250% 250%;
  animation: foil-shift 5s ease-in-out infinite;
}
.card.foil.card-rarity-epic {
  background: linear-gradient(115deg, var(--surface) 15%, #eaddfb 35%, #d8f3f7 50%, #eaddfb 65%, var(--surface) 85%);
  background-size: 280% 280%;
  animation: foil-shift 4s ease-in-out infinite;
}
.card.foil.card-rarity-legendary {
  border-color: var(--gold);
  background: linear-gradient(115deg, var(--surface) 10%, #fbe9b8 30%, #eaddfb 45%, #d8f3f7 60%, #fbe9b8 75%, var(--surface) 90%);
  background-size: 320% 320%;
  animation: foil-shift 3.2s ease-in-out infinite;
  box-shadow: 0 4px 16px rgba(120, 90, 60, 0.10), 0 0 14px rgba(232, 185, 58, 0.4);
}
@keyframes foil-shift {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}

.card.foil.shiny.card-rarity-common {
  border-color: #b9bec4;
  background: linear-gradient(115deg, var(--surface) 20%, #eef1f4 40%, var(--surface) 60%);
  background-size: 250% 250%;
  animation: foil-shift 5s ease-in-out infinite;
}

.glare {
  position: absolute;
  inset: 0;
  border-radius: 20px;
  background: transparent;
  mix-blend-mode: overlay;
  opacity: 0;
  transition: opacity 0.25s ease;
  pointer-events: none;
}
.card.tilting .glare { opacity: 1; }

.sparkle-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: 20px;
  pointer-events: none;
}
.sparkle-layer .dot {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 5px 1px rgba(255, 255, 255, 0.95);
  opacity: 0;
  animation: twinkle 2.6s ease-in-out infinite;
}
.sparkle-layer .dot:nth-child(1) { top: 14%; left: 20%; animation-delay: 0s; }
.sparkle-layer .dot:nth-child(2) { top: 30%; left: 78%; animation-delay: 0.4s; }
.sparkle-layer .dot:nth-child(3) { top: 55%; left: 12%; animation-delay: 0.9s; }
.sparkle-layer .dot:nth-child(4) { top: 68%; left: 60%; animation-delay: 1.3s; }
.sparkle-layer .dot:nth-child(5) { top: 20%; left: 50%; animation-delay: 1.8s; }
.sparkle-layer .dot:nth-child(6) { top: 80%; left: 85%; animation-delay: 2.2s; }
@keyframes twinkle {
  0%, 100% { opacity: 0; transform: scale(0.3); }
  50% { opacity: 1; transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .card.foil,
  .sparkle-layer .dot {
    animation: none !important;
    background-position: 0% 50% !important;
  }
}
```

- [ ] **Step 2: Verify in the browser**

Run: `npm run dev`, open the collection/album page with the dev server's printed local URL, and confirm: common owned cards are unchanged; rare/epic/legendary owned cards show an animated color-tinted sheen; a shiny common shows a subtle silver sheen; any shiny card shows twinkling white dots; unowned cards are unaffected. Toggle OS-level "reduce motion" (or DevTools Rendering tab → "Emulate CSS prefers-reduced-motion: reduce") and confirm the foil/sparkle animations freeze but colors/borders stay visible.

- [ ] **Step 3: Commit**

```bash
git add src/style.css
git commit -m "feat: foil and shiny sparkle CSS for rarity VFX"
```

---

### Task 3: 3D tilt + glare pointer interaction

**Files:**
- Create: `src/card-tilt.ts`
- Modify: `src/card.ts` (import and invoke the new handler from `renderCardHtml`)
- Modify: `src/style.css` (hover-gated tilt transition rules)

**Interfaces:**
- Consumes: `.card.foil` and `.glare` elements/classes produced by Tasks 1–2.
- Produces: `ensureCardTiltHandler(): void`, exported from `src/card-tilt.ts`, called once (idempotently) from `renderCardHtml` in `src/card.ts` — mirrors the existing `ensureInfoTooltipHandler()` singleton-guard pattern already in that file.

- [ ] **Step 1: Add the hover-gated tilt CSS**

In `src/style.css`, inside (or right after) the `@media (prefers-reduced-motion: reduce)` block added in Task 2, add:

```css
@media (hover: hover) and (pointer: fine) {
  .card.foil {
    transition: transform 0.35s ease;
    will-change: transform;
  }
  .card.foil.tilting {
    transition: none;
  }
}
```

- [ ] **Step 2: Create the tilt module**

Create `src/card-tilt.ts`:

```ts
const MAX_TILT_DEG = 12;

let handlerAttached = false;

export function ensureCardTiltHandler(): void {
  if (handlerAttached) return;
  handlerAttached = true;

  const canTilt =
    window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!canTilt) return;

  document.addEventListener("pointermove", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".card.foil");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const rotateY = (x - 0.5) * MAX_TILT_DEG * 2;
    const rotateX = (0.5 - y) * MAX_TILT_DEG * 2;
    card.classList.add("tilting");
    card.style.transform = `perspective(600px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.04)`;
    const glare = card.querySelector<HTMLElement>(".glare");
    if (glare) {
      glare.style.background = `radial-gradient(circle at ${x * 100}% ${y * 100}%, rgba(255,255,255,0.65), transparent 55%)`;
    }
  });

  document.addEventListener("pointerout", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".card.foil");
    if (!card) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && card.contains(related)) return;
    card.classList.remove("tilting");
    card.style.transform = "";
    const glare = card.querySelector<HTMLElement>(".glare");
    if (glare) glare.style.background = "transparent";
  });
}
```

- [ ] **Step 3: Wire it into `renderCardHtml`**

In `src/card.ts`, add the import at the top:

```ts
import { ensureCardTiltHandler } from "./card-tilt";
```

And inside `renderCardHtml`, right after the existing `ensureInfoTooltipHandler();` call (`src/card.ts:119`), add:

```ts
  ensureCardTiltHandler();
```

- [ ] **Step 4: Verify in the browser**

Run: `npm run dev`, open the collection/album page. Move the mouse over an owned rare/epic/legendary or shiny card: it should rotate to follow the cursor with a moving glare highlight, and ease back flat on mouse-leave. Confirm common non-shiny (no `.foil` class) and unowned cards don't tilt. Confirm nothing tilts with "reduce motion" emulated (DevTools Rendering tab). This matches the interaction already prototyped and approved live during design.

- [ ] **Step 5: Commit**

```bash
git add src/card-tilt.ts src/card.ts src/style.css
git commit -m "feat: 3D tilt and glare hover interaction for foil cards"
```
