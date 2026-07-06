# Shimmer en todos los sobres + cinta apoyo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Generalizar el bounce+shimmer (`.pack-wrapper`/`.pack-foil-shine`) a todos los sobres pendientes y añadir una cinta diagonal ★ que distinga el sobre `apoyo`, ya que deja de ser el único con shimmer.

**Architecture:** `renderPendingPacks` en `src/collection.ts` deja de gatear la creación del wrapper/shine por `shouldShowFoil(pack.tier)` — todo pack se envuelve. `shouldShowFoil` se sigue usando, pero solo para añadir la clase `apoyo` (borde dorado + cinta), no para decidir si hay wrapper. `style.css` mueve el bounce de `.pack-wrapper.apoyo` a `.pack-wrapper` a secas.

**Tech Stack:** TypeScript (Vite, sin framework), CSS puro.

## Global Constraints

- No tests unitarios nuevos: `renderPendingPacks` no está exportada y el cambio es puramente de rendering/CSS (spec: `docs/superpowers/specs/2026-07-06-pack-shimmer-apoyo-badge-design.md`).
- Verificación: `npx tsc --noEmit` + `npm test` (suite existente) deben seguir en verde tras cada task.
- Cinta solo ícono ★, sin texto (decidido en brainstorming).
- Cinta solo en el ícono de sobre sin abrir — no tocar overlay.html/pack-reveal.

---

### Task 1: Generalizar wrapper/shimmer a todos los sobres

**Files:**
- Modify: `src/collection.ts:74-102` (`renderPendingPacks`)
- Modify: `src/style.css:161-177`

**Interfaces:**
- Consumes: `shouldShowFoil(tier: PendingPack["tier"]): boolean` de `src/pack-tier-foil.ts` (sin cambios de firma)
- Produces: todo `<img class="pack-open-img">` de un pack pendiente queda envuelto en `<div class="pack-wrapper">` (+ `apoyo` si `shouldShowFoil`), con un `<div class="pack-foil-shine">` hermano — usado por Task 2.

- [x] **Step 1: Reescribir el bucle `packs.forEach` en `renderPendingPacks`**

Reemplazar el bloque `if (shouldShowFoil(pack.tier)) { ... } else { row.appendChild(img); }` (líneas 90-101) por:

```ts
    const wrapper = document.createElement("div");
    wrapper.className = shouldShowFoil(pack.tier) ? "pack-wrapper apoyo" : "pack-wrapper";
    wrapper.style.animationDelay = idleDelay;
    const shine = document.createElement("div");
    shine.className = "pack-foil-shine";
    wrapper.appendChild(img);
    wrapper.appendChild(shine);
    row.appendChild(wrapper);
```

- [x] **Step 2: Mover el bounce de `.pack-wrapper.apoyo` a `.pack-wrapper` en `style.css`**

Reemplazar (líneas 163-177):

```css
.pack-wrapper.apoyo {
  animation: pack-idle 2.4s ease-in-out infinite;
}
.pack-wrapper.apoyo:hover {
  animation-play-state: paused;
}
.pack-wrapper.apoyo:has(.pack-open-img.opening) {
  animation: none;
}

.pack-wrapper.apoyo .pack-open-img {
  border: 2px solid var(--gold);
  border-radius: 14px;
  animation: none;
}
```

por:

```css
.pack-wrapper {
  animation: pack-idle 2.4s ease-in-out infinite;
}
.pack-wrapper:hover {
  animation-play-state: paused;
}
.pack-wrapper:has(.pack-open-img.opening) {
  animation: none;
}
.pack-wrapper .pack-open-img {
  animation: none;
}

.pack-wrapper.apoyo .pack-open-img {
  border: 2px solid var(--gold);
  border-radius: 14px;
}
```

(La regla `:has(.pack-open-img.opening) .pack-foil-shine` que sigue debajo, línea ~189 tras el edit anterior, cambia su selector de `.pack-wrapper.apoyo:has(...)` a `.pack-wrapper:has(...)` — mismo tratamiento.)

- [x] **Step 3: Typecheck y test**

Run: `npx tsc --noEmit -p .`
Expected: sin output (sin errores)

Run: `npm test`
Expected: `9 passed (9)` / `64 passed (64)`

- [x] **Step 4: Commit**

```bash
git add src/collection.ts src/style.css
git commit -m "feat: apply bounce+shimmer to all pending packs, not just apoyo"
```

---

### Task 2: Cinta diagonal ★ para sobre apoyo

**Files:**
- Modify: `src/style.css` (tras el bloque `.pack-wrapper.apoyo .pack-open-img`, antes de `.pack-foil-shine`)

**Interfaces:**
- Consumes: clase `.pack-wrapper.apoyo` producida en Task 1.
- Produces: ninguna interfaz nueva consumida por otro task — es la última pieza visual.

- [x] **Step 1: Añadir `overflow: hidden` a `.pack-wrapper.apoyo` y la cinta**

Añadir en `style.css`, justo después del bloque `.pack-wrapper.apoyo .pack-open-img { ... }`:

```css
.pack-wrapper.apoyo {
  overflow: hidden;
}

.pack-apoyo-ribbon {
  position: absolute;
  top: 14px;
  left: -34px;
  width: 110px;
  padding: 2px 0;
  text-align: center;
  background: var(--gold);
  color: #fff;
  font-size: 0.8rem;
  transform: rotate(-45deg);
  box-shadow: 0 2px 6px rgba(120, 90, 60, 0.3);
  pointer-events: none;
  z-index: 2;
}
```

- [x] **Step 2: Crear el elemento de la cinta en `renderPendingPacks` (`src/collection.ts`)**

Dentro del `forEach`, tras crear `shine` y antes de `wrapper.appendChild(shine)`, añadir:

```ts
    if (shouldShowFoil(pack.tier)) {
      const ribbon = document.createElement("div");
      ribbon.className = "pack-apoyo-ribbon";
      ribbon.textContent = "★";
      wrapper.appendChild(ribbon);
    }
```

(Colocar esta llamada después de `wrapper.appendChild(shine);` para que la cinta quede por encima en el z-order del DOM.)

- [x] **Step 3: Typecheck y test**

Run: `npx tsc --noEmit -p .`
Expected: sin output

Run: `npm test`
Expected: `9 passed (9)` / `64 passed (64)`

- [x] **Step 4: Verificación manual**

`npm run dev`, abrir `/collection.html` con al menos un sobre `apoyo` y uno `gratis` pendientes (o usar `/admin/test-pack` para generarlos). Confirmar:
- Ambos sobres tienen bounce + shimmer diagonal.
- Solo el `apoyo` tiene borde dorado + cinta ★ en la esquina superior izquierda.
- El hover-pop del sobre apoyo se ve bien pese al `overflow: hidden` (recorte esperado ~2px, no debe verse roto).

- [x] **Step 5: Commit**

```bash
git add src/collection.ts src/style.css
git commit -m "feat: add corner ribbon badge to apoyo packs"
```
