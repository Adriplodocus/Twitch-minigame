# Pack-Open Image Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the text `"Abrir sobre"` buttons in the collection page with clickable pack-artwork images, per `docs/superpowers/specs/2026-07-02-pack-open-image-button-design.md`.

**Architecture:** Pure frontend change — `src/collection.ts`'s `renderPendingPacks()` swaps `<button>` creation for `<img>` creation, and `src/style.css` gains a `.pack-open-img` class reusing the existing `.card` hover-lift pattern. No backend, no test suite touches this file today.

**Tech Stack:** Vanilla TS, plain CSS, Vite.

## Global Constraints

- One `<img>` per pending pack (same 1:1 mapping as today's one-button-per-pack).
- No visible numbering/label on the images (drop the `"Abrir sobre N"` text).
- Image source: `/pack.png` (user supplies the actual file separately — not part of this plan).
- Click → image becomes non-interactive (dimmed, `pointer-events: none`) → calls `onOpen(pack.id)` → interactivity restored when the promise settles, matching today's `.finally()` behavior.
- Size: `140px` wide, matching `.card-reveal`/the card grid's column width.
- Hover: reuse `.card`'s existing lift pattern (`transform: translateY(-4px)` + `box-shadow: 0 10px 26px rgba(120, 90, 60, 0.18)` on hover, `box-shadow: 0 4px 16px rgba(120, 90, 60, 0.10)` at rest, `transition: transform 0.18s, box-shadow 0.18s`).
- No automated test coverage exists for `src/collection.ts` today (confirmed: no `test/**/collection*.ts` covers the frontend file, only `worker/routes/collection.ts`'s backend route) — verification for this plan is `npm run dev` + manual browser check, not new automated tests.

---

### Task 1: Image-based pack-open buttons

**Files:**
- Modify: `src/collection.ts:31-52` (the `renderPendingPacks` function)
- Modify: `src/style.css` (add `.pack-open-img` class after the existing `.card-reveal` rule at line 69)

**Interfaces:**
- Consumes: nothing new — `renderPendingPacks(packs: PendingPack[], onOpen: (id: number) => Promise<void>)` keeps its exact existing signature (called from `load()` at the bottom of `src/collection.ts`, which is NOT touched by this task).
- Produces: nothing consumed by other tasks — this is the only task in this plan.

- [ ] **Step 1: Add the `.pack-open-img` CSS class**

In `src/style.css`, immediately after the existing line:

```css
.card-reveal { width: 140px; flex: 0 0 auto; }
```

add:

```css

.pack-open-img {
  width: 140px;
  border-radius: 14px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(120, 90, 60, 0.10);
  transition: transform 0.18s, box-shadow 0.18s;
}
.pack-open-img:hover {
  transform: translateY(-4px);
  box-shadow: 0 10px 26px rgba(120, 90, 60, 0.18);
}
.pack-open-img.opening {
  opacity: 0.5;
  pointer-events: none;
}
```

- [ ] **Step 2: Rewrite `renderPendingPacks` to use images**

In `src/collection.ts`, replace the full body of `renderPendingPacks` (currently lines 31-52):

```ts
function renderPendingPacks(packs: PendingPack[], onOpen: (id: number) => Promise<void>): void {
  const container = document.getElementById("pending-packs")!;
  if (packs.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `<h2>Sobres pendientes (${packs.length})</h2>`;
  packs.forEach((pack, index) => {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.style.marginTop = "0.75rem";
    const label = packs.length > 1 ? `Abrir sobre ${index + 1}` : "Abrir sobre";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Abriendo...";
      onOpen(pack.id).finally(() => {
        btn.disabled = false;
        btn.textContent = label;
      });
    });
    container.appendChild(btn);
  });
}
```

with:

```ts
function renderPendingPacks(packs: PendingPack[], onOpen: (id: number) => Promise<void>): void {
  const container = document.getElementById("pending-packs")!;
  if (packs.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `<h2>Sobres pendientes (${packs.length})</h2>`;
  const row = document.createElement("div");
  row.style.cssText = "display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.75rem;";
  container.appendChild(row);

  packs.forEach((pack) => {
    const img = document.createElement("img");
    img.className = "pack-open-img";
    img.src = "/pack.png";
    img.alt = "Abrir sobre";
    img.addEventListener("click", () => {
      img.classList.add("opening");
      onOpen(pack.id).finally(() => {
        img.classList.remove("opening");
      });
    });
    row.appendChild(img);
  });
}
```

- [ ] **Step 3: Verify in the browser**

Run: `npm run dev`

With a test account that has 0 pending packs: confirm the `#pending-packs` container is empty (no `<h2>`, no images) — same as today's behavior.

With a test account that has 1+ pending packs (grant one via the existing test flow, e.g. by triggering the Twitch reward redemption path used in `test/routes/collection.test.ts`, or by inserting a row directly into the local D1 `packs` table with `opened_at IS NULL` via `npx wrangler d1 execute twitch-cards-db --local --command "INSERT INTO packs (user_id, created_at) VALUES ('<your-test-twitch-id>', CURRENT_TIMESTAMP);"`): confirm one `<img class="pack-open-img">` renders per pending pack, each 140px wide, each showing a broken-image icon (expected — `/pack.png` doesn't exist yet, that's the user's separate task), each with a visible hover-lift effect, and clicking one dims it (`opening` class) and triggers the existing open/reveal flow (the reveal overlay still appears once the pack opens, exactly as it did with the old button).

- [ ] **Step 4: Commit**

```bash
git add src/collection.ts src/style.css
git commit -m "feat: replace pack-open buttons with clickable pack images"
```
