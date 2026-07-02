# Trade Flow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `trade.html` search hub with a shareable per-user trade link, add name-filter/sort to the offer builder, and move the offers list to its own page.

**Architecture:** `trade.html` is entered only via `?with=<username>`; `offers.html` is a new page hosting the sent/received offers list moved out of `trade.ts`; `collection.html` and `album.html` gain "copy my trade link" and "Ofertas" buttons; `GET /auth/me` starts returning the caller's username so the frontend can build its own share link.

**Tech Stack:** Hono (Cloudflare Worker backend), vanilla TypeScript + Vite multi-page app (frontend), vitest + `@cloudflare/vitest-pool-workers` for backend tests. No frontend unit-test harness exists in this repo — frontend changes are verified by `npx tsc -b` (type-check) plus manual browser testing with `npm run dev`, matching current project conventions.

## Global Constraints

- No database schema changes.
- No new backend routes; only `GET /auth/me`'s response body changes.
- Card size/visual design of `.card` stays exactly as-is — no shrinking, no stepper redesign (explicitly rejected during brainstorming).
- All new UI copy is in Spanish, matching existing pages.
- Name-filter and sort are entirely client-side (no new query params, no new round-trips).
- Spec: `docs/superpowers/specs/2026-07-02-trade-flow-redesign-design.md`.

---

### Task 1: `GET /auth/me` returns the caller's username

**Files:**
- Modify: `worker/routes/auth.ts:10`
- Modify: `test/routes/auth.test.ts:17-22`

**Interfaces:**
- Produces: `GET /api/auth/me` response body becomes `{ ok: true, username: string }` (was `{ ok: true }`).

- [ ] **Step 1: Extend the existing test to assert the username field (failing)**

Replace the test at `test/routes/auth.test.ts:17-22`:

```ts
it("accepts /me with a valid session cookie", async () => {
  const { signSession } = await import("../../worker/lib/jwt");
  const token = await signSession({ twitchId: "1", username: "viewer1" }, env.JWT_SECRET);
  const res = await app.request("/api/auth/me", { headers: { Cookie: `session=${token}` } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ ok: boolean; username: string }>();
  expect(json.username).toBe("viewer1");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/auth.test.ts -t "accepts /me"`
Expected: FAIL — `json.username` is `undefined`, not `"viewer1"`.

- [ ] **Step 3: Return the username from the route**

In `worker/routes/auth.ts:10`, replace:

```ts
auth.get("/me", requireAuth, (c) => c.json({ ok: true }));
```

with:

```ts
auth.get("/me", requireAuth, (c) => c.json({ ok: true, username: c.get("user").username }));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/auth.test.ts -t "accepts /me"`
Expected: PASS

- [ ] **Step 5: Run the full auth test file to check for regressions**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/auth.test.ts`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add worker/routes/auth.ts test/routes/auth.test.ts
git commit -m "feat: return username from GET /auth/me"
```

---

### Task 2: Add `getMe()` to the frontend API client

**Files:**
- Modify: `src/api.ts` (add after the `logout` function, around line 41)

**Interfaces:**
- Consumes: `request<T>(path, init?)` (existing helper in `src/api.ts:25`).
- Produces: `getMe(): Promise<{ ok: boolean; username: string }>`, used by Task 4.

- [ ] **Step 1: Add the function**

In `src/api.ts`, after the `logout` function (line 41), add:

```ts
export function getMe(): Promise<{ ok: boolean; username: string }> {
  return request("/auth/me");
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat: add getMe() to the frontend API client"
```

---

### Task 3: Move sort logic into `card.ts`, add name-filter helper

**Files:**
- Modify: `src/card.ts` (add near the top, after the `CardView` import)
- Modify: `src/collection.ts:1-19` (remove the duplicated `SortField`/`compareCards`, import from `card.ts`)

**Interfaces:**
- Produces: `card.ts` exports `type SortField = "pokedex" | "recent" | "quantity"`, `compareCards(a: CardView, b: CardView, field: SortField): number`, and `filterCardsByName(cards: CardView[], query: string): CardView[]`. Task 8 (`trade.ts`) imports all three.

- [ ] **Step 1: Add the shared helpers to `card.ts`**

In `src/card.ts`, right after the `import type { CardView } from "./api";` line, add:

```ts
export type SortField = "pokedex" | "recent" | "quantity";

export function compareCards(a: CardView, b: CardView, field: SortField): number {
  switch (field) {
    case "pokedex":
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    case "recent":
      return (a.acquiredAt ?? "").localeCompare(b.acquiredAt ?? "");
    case "quantity":
      return a.quantity - b.quantity;
  }
}

export function filterCardsByName(cards: CardView[], query: string): CardView[] {
  const q = query.trim().toLowerCase();
  if (!q) return cards;
  return cards.filter((c) => c.name.toLowerCase().includes(q));
}
```

- [ ] **Step 2: Update `collection.ts` to use the shared helpers**

In `src/collection.ts`, replace lines 1-19:

```ts
import { getCollection, openPack, logout, type CardView, type PendingPack } from "./api";
import { renderCardHtml, collectFemaleVariantBaseNames, computeFormLabels, splitCardName } from "./card";

let femaleVariantBaseNames = new Set<string>();
let formLabels = new Map<string, string>();
let ownedCards: CardView[] = [];

type SortField = "pokedex" | "recent" | "quantity";

function compareCards(a: CardView, b: CardView, field: SortField): number {
  switch (field) {
    case "pokedex":
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    case "recent":
      return (a.acquiredAt ?? "").localeCompare(b.acquiredAt ?? "");
    case "quantity":
      return a.quantity - b.quantity;
  }
}
```

with:

```ts
import { getCollection, openPack, logout, type CardView, type PendingPack } from "./api";
import { renderCardHtml, collectFemaleVariantBaseNames, computeFormLabels, splitCardName, compareCards, type SortField } from "./card";

let femaleVariantBaseNames = new Set<string>();
let formLabels = new Map<string, string>();
let ownedCards: CardView[] = [];
```

(The rest of `collection.ts`, including `renderOwnedGrid`'s `field as SortField` cast, is unchanged — `SortField` is now imported instead of locally declared.)

- [ ] **Step 3: Type-check**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 4: Manual smoke check**

Run: `npm run dev`, open `/collection.html`, confirm the Pokédex/Recientes/Cantidad sort dropdowns still reorder the grid correctly (unchanged behavior — this step only proves the refactor didn't break anything).

- [ ] **Step 5: Commit**

```bash
git add src/card.ts src/collection.ts
git commit -m "refactor: move compareCards/SortField to card.ts, add filterCardsByName"
```

---

### Task 4: Shared "copy trade link" button behavior

**Files:**
- Create: `src/trade-link.ts`

**Interfaces:**
- Consumes: `getMe()` from `src/api.ts` (Task 2).
- Produces: `attachTradeLinkButton(buttonId: string): void`, used by Task 5 (`collection.ts`) and Task 6 (`album.ts`).

- [ ] **Step 1: Create the module**

```ts
// src/trade-link.ts
import { getMe } from "./api";

export function attachTradeLinkButton(buttonId: string): void {
  const btn = document.getElementById(buttonId) as HTMLButtonElement;
  const originalLabel = btn.textContent;
  btn.addEventListener("click", async () => {
    const { username } = await getMe();
    const url = `${window.location.origin}/trade.html?with=${encodeURIComponent(username)}`;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "¡Copiado!";
    } catch {
      window.prompt("Copiá tu enlace de trade:", url);
    }
    setTimeout(() => {
      btn.textContent = originalLabel;
    }, 1500);
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -b`
Expected: no errors (module isn't imported anywhere yet, so this only checks the file itself is well-typed)

- [ ] **Step 3: Commit**

```bash
git add src/trade-link.ts
git commit -m "feat: add shared attachTradeLinkButton helper"
```

---

### Task 5: Wire the Trade/Ofertas buttons into `collection.html`

**Files:**
- Modify: `collection.html:19` (nav buttons)
- Modify: `src/collection.ts` (wire the new button)

**Interfaces:**
- Consumes: `attachTradeLinkButton` (Task 4).

- [ ] **Step 1: Replace the nav in `collection.html`**

Replace line 19 (`<a class="btn" href="/trade.html">Ir a Trading</a>`) with:

```html
<button class="btn" id="trade-link-btn" type="button">Copiar enlace de trade</button>
<a class="btn" href="/offers.html">Ofertas</a>
```

So the nav block (`collection.html:18-21`) reads:

```html
<div style="display: flex; gap: 0.75rem; margin-top: 1rem;">
  <button class="btn" id="trade-link-btn" type="button">Copiar enlace de trade</button>
  <a class="btn" href="/offers.html">Ofertas</a>
  <a class="btn" href="/album.html">Ver Álbum</a>
  <button class="btn" id="logout-btn">Cerrar sesión</button>
</div>
```

- [ ] **Step 2: Wire it in `src/collection.ts`**

Add the import at the top of `src/collection.ts`:

```ts
import { attachTradeLinkButton } from "./trade-link";
```

Add this call near the bottom, alongside the other `addEventListener` wiring (before `load();`):

```ts
attachTradeLinkButton("trade-link-btn");
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 4: Manual smoke check**

Run: `npm run dev`, open `/collection.html` logged in as a test user, click "Copiar enlace de trade", confirm the button briefly shows "¡Copiado!" and the clipboard contains `.../trade.html?with=<your username>`.

- [ ] **Step 5: Commit**

```bash
git add collection.html src/collection.ts
git commit -m "feat: add trade-link and offers buttons to collection page"
```

---

### Task 6: Wire the Trade/Ofertas buttons into `album.html`

**Files:**
- Modify: `album.html:19` (nav buttons)
- Modify: `src/album.ts`

**Interfaces:**
- Consumes: `attachTradeLinkButton` (Task 4).

- [ ] **Step 1: Replace the nav in `album.html`**

Replace line 19 (`<a class="btn" href="/trade.html">Ir a Trading</a>`) with:

```html
<button class="btn" id="trade-link-btn" type="button">Copiar enlace de trade</button>
<a class="btn" href="/offers.html">Ofertas</a>
```

So the nav block (`album.html:18-21`) reads:

```html
<div style="display: flex; gap: 0.75rem; margin-top: 1rem;">
  <a class="btn" href="/collection.html">Volver a Colección</a>
  <button class="btn" id="trade-link-btn" type="button">Copiar enlace de trade</button>
  <a class="btn" href="/offers.html">Ofertas</a>
  <button class="btn" id="logout-btn">Cerrar sesión</button>
</div>
```

- [ ] **Step 2: Wire it in `src/album.ts`**

Replace the full contents of `src/album.ts` with:

```ts
import { getCollection, logout, type CardView } from "./api";
import { renderCardHtml, collectFemaleVariantBaseNames, computeFormLabels } from "./card";
import { attachTradeLinkButton } from "./trade-link";

async function load(): Promise<void> {
  const data = await getCollection();
  const femaleVariantBaseNames = collectFemaleVariantBaseNames(data.cards);
  const formLabels = computeFormLabels(data.cards);
  const owned = data.cards.filter((c: CardView) => c.quantity > 0).length;

  document.getElementById("album-heading")!.innerHTML =
    `Pokédex <span class="count">(${owned}/${data.cards.length})</span>`;
  document.getElementById("album-grid")!.innerHTML = data.cards
    .map((c) => renderCardHtml(c, "", femaleVariantBaseNames, formLabels))
    .join("");
}

document.getElementById("logout-btn")!.addEventListener("click", async () => {
  await logout();
  window.location.href = "/";
});
attachTradeLinkButton("trade-link-btn");

load();
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 4: Manual smoke check**

Run: `npm run dev`, open `/album.html`, click "Copiar enlace de trade", confirm same behavior as Task 5.

- [ ] **Step 5: Commit**

```bash
git add album.html src/album.ts
git commit -m "feat: add trade-link and offers buttons to album page"
```

---

### Task 7: New `offers.html` page (moved out of `trade.html`)

**Files:**
- Create: `offers.html`
- Create: `src/offers.ts`
- Modify: `vite.config.ts:14` (add the `offers` build entry)

**Interfaces:**
- Consumes: `listOffers`, `acceptOffer`, `declineOffer`, `cancelOffer`, `logout`, `type TradeOfferItem`, `type TradeOfferSummary` (all already exist in `src/api.ts`); `renderCardHtml` (`src/card.ts`).
- Produces: `/offers.html` page. Task 8 removes this code from `trade.ts`/`trade.html`.

- [ ] **Step 1: Create `offers.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Russo+One&family=Quicksand:wght@500;700&family=JetBrains+Mono:wght@600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/src/style.css" />
    <title>Ofertas</title>
  </head>
  <body>
    <div class="container" style="padding: 2rem 1rem;">
      <h1>Ofertas</h1>
      <div style="display: flex; gap: 0.75rem; margin-top: 1rem;">
        <a class="btn" href="/collection.html">Volver a Colección</a>
        <button class="btn" id="logout-btn">Cerrar sesión</button>
      </div>

      <div style="margin-top: 2rem;">
        <div id="offers-list"></div>
      </div>
    </div>
    <script type="module" src="/src/offers.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/offers.ts`**

```ts
import {
  listOffers,
  acceptOffer,
  declineOffer,
  cancelOffer,
  logout,
  type TradeOfferItem,
  type TradeOfferSummary,
} from "./api";
import { renderCardHtml } from "./card";

function renderOfferItems(items: TradeOfferItem[], side: "from" | "to"): string {
  const filtered = items.filter((item) => item.side === side);
  if (filtered.length === 0) return `<p style="color: var(--dim);">— nada —</p>`;
  return `<div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">${filtered
    .map((item) => renderCardHtml({ id: item.cardId, name: item.name, rarity: item.rarity, imagePath: item.imagePath, quantity: item.quantity }))
    .join("")}</div>`;
}

function renderOffer(offer: TradeOfferSummary, kind: "sent" | "received"): string {
  const label = kind === "sent" ? `Para: ${offer.toUser}` : `De: ${offer.fromUser}`;
  const actions =
    kind === "received" && offer.status === "pending"
      ? `<button class="btn accept-btn" data-id="${offer.id}">Aceptar</button>
         <button class="btn decline-btn" data-id="${offer.id}">Rechazar</button>`
      : kind === "sent" && offer.status === "pending"
        ? `<button class="btn cancel-btn" data-id="${offer.id}">Cancelar</button>`
        : "";
  return `<div class="card" style="margin-top: 0.75rem;">
    ${label} — <span class="badge">${offer.status}</span>
    <p style="margin-top: 0.5rem; color: var(--muted);">Ofrece</p>
    ${renderOfferItems(offer.items, "from")}
    <p style="margin-top: 0.5rem; color: var(--muted);">Pide</p>
    ${renderOfferItems(offer.items, "to")}
    <div style="margin-top: 0.5rem;">${actions}</div>
  </div>`;
}

async function loadOffers(): Promise<void> {
  const { sent, received } = await listOffers();
  const container = document.getElementById("offers-list")!;
  container.innerHTML =
    "<h3>Recibidas</h3>" +
    received.map((o) => renderOffer(o, "received")).join("") +
    "<h3 style='margin-top: 1rem;'>Enviadas</h3>" +
    sent.map((o) => renderOffer(o, "sent")).join("");

  container.querySelectorAll<HTMLButtonElement>(".accept-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await acceptOffer(Number(btn.dataset.id));
      await loadOffers();
    })
  );
  container.querySelectorAll<HTMLButtonElement>(".decline-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await declineOffer(Number(btn.dataset.id));
      await loadOffers();
    })
  );
  container.querySelectorAll<HTMLButtonElement>(".cancel-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await cancelOffer(Number(btn.dataset.id));
      await loadOffers();
    })
  );
}

document.getElementById("logout-btn")!.addEventListener("click", async () => {
  await logout();
  window.location.href = "/";
});

loadOffers();
```

- [ ] **Step 3: Register the new page in `vite.config.ts`**

In `vite.config.ts`, in the `rollupOptions.input` object (line 14, right after `trade: path.resolve(__dirname, "trade.html"),`), add:

```ts
offers: path.resolve(__dirname, "offers.html"),
```

So the object reads:

```ts
input: {
  main: path.resolve(__dirname, "index.html"),
  collection: path.resolve(__dirname, "collection.html"),
  trade: path.resolve(__dirname, "trade.html"),
  offers: path.resolve(__dirname, "offers.html"),
  album: path.resolve(__dirname, "album.html"),
  admin: path.resolve(__dirname, "admin.html"),
},
```

- [ ] **Step 4: Type-check**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 5: Manual smoke check**

Run: `npm run dev`, log in as two different test users, create a trade offer between them via the existing (still-unmodified at this point) `trade.html` flow, then open `/offers.html` for both users and confirm the sent/received lists, accept/decline/cancel all work exactly as before.

- [ ] **Step 6: Commit**

```bash
git add offers.html src/offers.ts vite.config.ts
git commit -m "feat: add standalone /offers.html page"
```

---

### Task 8: Rewrite `trade.html`/`trade.ts` as a share-link offer builder

**Files:**
- Modify: `trade.html` (full rewrite)
- Modify: `src/trade.ts` (full rewrite)

**Interfaces:**
- Consumes: `getCollection`, `getUserCollection`, `createOffer`, `getMe`, `logout`, `type CardView` (`src/api.ts`); `renderCardHtml`, `collectFemaleVariantBaseNames`, `computeFormLabels`, `compareCards`, `filterCardsByName`, `type SortField` (`src/card.ts`, from Task 3).
- Produces: the offer-list code that used to live in `trade.ts` is gone (moved to `offers.ts` in Task 7) — this task deletes it from `trade.ts` rather than duplicating it.

- [ ] **Step 1: Replace `trade.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Russo+One&family=Quicksand:wght@500;700&family=JetBrains+Mono:wght@600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/src/style.css" />
    <title>Trading</title>
  </head>
  <body>
    <div class="container" style="padding: 2rem 1rem;">
      <h1 id="trade-heading">Trading</h1>
      <div style="display: flex; gap: 0.75rem; margin-top: 1rem;">
        <a class="btn" href="/collection.html">Volver a Colección</a>
        <button class="btn" id="logout-btn">Cerrar sesión</button>
      </div>

      <div id="trade-error" style="display: none; margin-top: 1.5rem; color: #C24747; font-weight: 700;"></div>

      <div id="offer-builder" style="display: none; margin-top: 1.5rem;">
        <h2 id="target-heading">Cartas</h2>
        <input
          class="input"
          id="target-filter"
          placeholder="Buscar por nombre"
          style="margin-top: 0.75rem; width: 100%; max-width: 320px;"
        />
        <div id="target-collection" class="card-grid"></div>

        <h2 style="margin-top: 1.5rem;">Tus cartas</h2>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem;">
          <select id="sort-field" class="input">
            <option value="pokedex">Pokédex</option>
            <option value="recent">Recientes</option>
            <option value="quantity">Cantidad</option>
          </select>
          <select id="sort-direction" class="input">
            <option value="asc">Ascendente</option>
            <option value="desc">Descendente</option>
          </select>
          <input class="input" id="my-filter" placeholder="Buscar por nombre" style="flex: 1; min-width: 160px;" />
        </div>
        <div id="my-cards" class="card-grid"></div>

        <button class="btn" id="send-offer-btn" style="margin-top: 1.5rem;">Enviar oferta</button>
      </div>
    </div>
    <script type="module" src="/src/trade.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Replace `src/trade.ts`**

```ts
import { getCollection, getUserCollection, createOffer, getMe, logout, type CardView } from "./api";
import {
  renderCardHtml,
  collectFemaleVariantBaseNames,
  computeFormLabels,
  compareCards,
  filterCardsByName,
  type SortField,
} from "./card";

let currentTargetUsername = "";
let myCards: CardView[] = [];
let targetCards: CardView[] = [];
let myFemaleVariants = new Set<string>();
let targetFemaleVariants = new Set<string>();
let myFormLabels = new Map<string, string>();
let targetFormLabels = new Map<string, string>();
const offerQuantities = new Map<string, number>();
const requestQuantities = new Map<string, number>();

function renderSelectableCard(
  card: CardView,
  inputClass: string,
  quantities: Map<string, number>,
  femaleVariantBaseNames: Set<string>,
  formLabels: Map<string, string>
): string {
  if (card.quantity === 0) return "";
  const value = quantities.get(card.id) ?? 0;
  const input = `
    <input
      type="number"
      class="input ${inputClass}"
      data-card-id="${card.id}"
      min="0"
      max="${card.quantity}"
      value="${value}"
      style="margin-top: 0.5rem; width: 100%;"
    />
  `;
  return renderCardHtml(card, input, femaleVariantBaseNames, formLabels);
}

function renderTargetGrid(): void {
  const query = (document.getElementById("target-filter") as HTMLInputElement).value;
  const filtered = filterCardsByName(targetCards, query);
  document.getElementById("target-collection")!.innerHTML = filtered
    .map((c) => renderSelectableCard(c, "request-qty", requestQuantities, targetFemaleVariants, targetFormLabels))
    .join("");
}

function renderMyGrid(): void {
  const field = (document.getElementById("sort-field") as HTMLSelectElement).value as SortField;
  const direction = (document.getElementById("sort-direction") as HTMLSelectElement).value;
  const sign = direction === "desc" ? -1 : 1;
  const query = (document.getElementById("my-filter") as HTMLInputElement).value;
  const filtered = filterCardsByName(myCards, query).sort((a, b) => compareCards(a, b, field) * sign);
  document.getElementById("my-cards")!.innerHTML = filtered
    .map((c) => renderSelectableCard(c, "offer-qty", offerQuantities, myFemaleVariants, myFormLabels))
    .join("");
}

function trackQuantity(e: Event, inputClass: string, quantities: Map<string, number>): void {
  const target = e.target as HTMLElement;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains(inputClass)) return;
  const cardId = target.dataset.cardId!;
  const value = Number(target.value);
  if (value > 0) quantities.set(cardId, value);
  else quantities.delete(cardId);
}

function quantitiesToItems(quantities: Map<string, number>): { cardId: string; quantity: number }[] {
  return Array.from(quantities, ([cardId, quantity]) => ({ cardId, quantity }));
}

function showError(message: string): void {
  const errorEl = document.getElementById("trade-error")!;
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

async function init(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const targetUsername = params.get("with");
  if (!targetUsername) {
    showError("Falta el usuario con quien comerciar. Pedile a alguien su enlace de trade.");
    return;
  }

  const me = await getMe();
  if (me.username === targetUsername) {
    showError("No podés intercambiar con vos mismo.");
    return;
  }

  const myCollection = await getCollection();
  myCards = myCollection.cards;

  let target: { username: string; cards: CardView[] };
  try {
    target = await getUserCollection(targetUsername);
  } catch {
    showError(`No se encontró a ${targetUsername}.`);
    return;
  }
  targetCards = target.cards;
  currentTargetUsername = targetUsername;

  document.getElementById("trade-heading")!.textContent = `Intercambio con ${targetUsername}`;
  document.getElementById("target-heading")!.textContent = `Cartas de ${targetUsername}`;

  myFemaleVariants = collectFemaleVariantBaseNames(myCards);
  targetFemaleVariants = collectFemaleVariantBaseNames(targetCards);
  myFormLabels = computeFormLabels(myCards);
  targetFormLabels = computeFormLabels(targetCards);

  renderTargetGrid();
  renderMyGrid();
  document.getElementById("offer-builder")!.style.display = "block";
}

async function sendOffer(): Promise<void> {
  if (!currentTargetUsername) return;
  const offerCards = quantitiesToItems(offerQuantities);
  const requestCards = quantitiesToItems(requestQuantities);
  if (offerCards.length === 0 && requestCards.length === 0) return;

  await createOffer({ toUsername: currentTargetUsername, offerCards, requestCards });
  window.location.href = "/offers.html";
}

document.getElementById("target-filter")!.addEventListener("input", renderTargetGrid);
document.getElementById("sort-field")!.addEventListener("change", renderMyGrid);
document.getElementById("sort-direction")!.addEventListener("change", renderMyGrid);
document.getElementById("my-filter")!.addEventListener("input", renderMyGrid);
document.getElementById("target-collection")!.addEventListener("input", (e) => trackQuantity(e, "request-qty", requestQuantities));
document.getElementById("my-cards")!.addEventListener("input", (e) => trackQuantity(e, "offer-qty", offerQuantities));
document.getElementById("send-offer-btn")!.addEventListener("click", sendOffer);
document.getElementById("logout-btn")!.addEventListener("click", async () => {
  await logout();
  window.location.href = "/";
});

init();
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 4: Run the backend trade test suite (unaffected, but confirms no regressions in the routes this page calls)**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/trade.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Manual smoke check**

Run: `npm run dev`. With two logged-in test users (A and B):
1. As A, go to `/collection.html`, click "Copiar enlace de trade", note the copied URL.
2. As B, open that URL. Confirm: header says "Intercambio con A", A's cards render above with a name filter, B's own cards render below with sort + name filter.
3. Type a quantity on one of A's cards and one of B's own cards, then change the sort order and type into the name filter — confirm the previously-entered quantities are preserved (don't reset to 0) even though the grids re-render.
4. Click "Enviar oferta" as B, confirm redirect to `/offers.html`. Confirm the offer shows up under "Enviadas" when B views `/offers.html`, and under "Recibidas" when A views `/offers.html`.
5. Open `/trade.html` directly with no `?with=` param — confirm the error message shows and no grids render.
6. Open `/trade.html?with=<own username>` — confirm the "no podés intercambiar con vos mismo" message.
7. Open `/trade.html?with=nonexistent_user_xyz` — confirm the "no se encontró" message.

- [ ] **Step 6: Commit**

```bash
git add trade.html src/trade.ts
git commit -m "feat: rewrite trade page as a share-link offer builder with search/sort"
```

---

### Task 9: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `npm run test:worker`
Expected: all tests PASS

- [ ] **Step 2: Run the tools test suite**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 3: Full type-check**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: build succeeds, `dist/client` contains `trade.html`, `offers.html`, `collection.html`, `album.html`, `admin.html`, `index.html`.

- [ ] **Step 5: Final manual pass**

Run: `npm run dev` and repeat the full flow from Task 8 Step 5 end-to-end once more, plus: confirm `/collection.html` and `/album.html` both show working "Copiar enlace de trade" and "Ofertas" buttons, and that `/offers.html` accept/decline/cancel actions still update card ownership correctly (spot-check one accept against the DB via the existing collection view).

- [ ] **Step 6: Commit (only if Step 5 turned up fixes)**

If no fixes were needed, there's nothing to commit for this task.
