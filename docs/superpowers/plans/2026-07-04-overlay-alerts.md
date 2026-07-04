# Overlay Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user, right after opening a pack, choose to show what they got on the streamer's OBS overlay via an explicit "Cerrar y mostrar en stream" button.

**Architecture:** A new `packs.broadcast_at` column marks a pack as opted-in for display. A new authenticated endpoint sets it; a new public, unauthenticated endpoint (`overlay.html` has no login — it's an OBS Browser Source) polls for packs broadcast since a cursor and returns their cards. `overlay.ts` polls every 4s and queues alerts, reusing the existing `renderCardHtml` card rendering so the overlay matches the site's visual language.

**Tech Stack:** Cloudflare Workers (Hono), D1 (SQLite), Vitest (`@cloudflare/vitest-pool-workers`), vanilla TS frontend, Vite multi-page build.

## Global Constraints

- No KV, no Durable Objects, no paid Cloudflare add-ons — polling against D1 only.
- No global user preference/toggle — broadcasting is an explicit per-pack-opening choice.
- All cards in the pack are shown (no rarity filter yet), but the events endpoint returns full per-card `rarity` so a future client-side filter needs no schema or endpoint change.
- `overlay.html` requires no authentication.

---

### Task 1: `packs.broadcast_at` column + authenticated broadcast endpoint

**Files:**
- Create: `migrations/0010_pack_broadcast.sql`
- Modify: `worker/routes/collection.ts` (add `POST /packs/:id/broadcast`)
- Modify: `test/routes/collection.test.ts` (add broadcast tests)

**Interfaces:**
- Produces: `POST /api/collection/packs/:id/broadcast` (requireAuth) → `200 { ok: true }` on success, `404` if the pack isn't the caller's, `409` if it hasn't been opened yet. Sets `packs.broadcast_at = CURRENT_TIMESTAMP`.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE packs ADD COLUMN broadcast_at TEXT;
```

Save as `migrations/0010_pack_broadcast.sql`.

- [ ] **Step 2: Write failing tests in `test/routes/collection.test.ts`**

Append these three tests to the file:

```ts
it("marks an opened pack as broadcast", async () => {
  const packResult = await env.DB.prepare(
    "INSERT INTO packs (user_id, opened_at) VALUES (?, CURRENT_TIMESTAMP) RETURNING id"
  )
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/broadcast`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(200);

  const pack = await env.DB.prepare("SELECT broadcast_at FROM packs WHERE id = ?")
    .bind(packResult!.id)
    .first<{ broadcast_at: string | null }>();
  expect(pack?.broadcast_at).not.toBeNull();
});

it("rejects broadcasting a pack that hasn't been opened yet", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/broadcast`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects broadcasting a pack that belongs to another user", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2").run();
  const packResult = await env.DB.prepare(
    "INSERT INTO packs (user_id, opened_at) VALUES (?, CURRENT_TIMESTAMP) RETURNING id"
  )
    .bind("2")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/broadcast`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(404);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:worker -- collection.test.ts`
Expected: FAIL (404, route doesn't exist) for all three new tests.

- [ ] **Step 4: Add the route in `worker/routes/collection.ts`**

Insert this new route right after the existing `/packs/:id/open` handler (before `export default collection;`):

```ts
collection.post("/packs/:id/broadcast", requireAuth, async (c) => {
  const user = c.get("user");
  const packId = Number(c.req.param("id"));

  const pack = await c.env.DB.prepare("SELECT id, user_id, opened_at FROM packs WHERE id = ?")
    .bind(packId)
    .first<{ id: number; user_id: string; opened_at: string | null }>();
  if (!pack || pack.user_id !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (!pack.opened_at) return c.json({ error: "Pack not opened yet" }, 409);

  await c.env.DB.prepare("UPDATE packs SET broadcast_at = CURRENT_TIMESTAMP WHERE id = ?").bind(packId).run();
  return c.json({ ok: true });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:worker -- collection.test.ts`
Expected: PASS (all tests, including pre-existing ones)

- [ ] **Step 6: Commit**

```bash
git add migrations/0010_pack_broadcast.sql worker/routes/collection.ts test/routes/collection.test.ts
git commit -m "feat: let users mark an opened pack for stream broadcast"
```

---

### Task 2: Public overlay events endpoint

**Files:**
- Create: `worker/routes/overlay.ts`
- Create: `test/routes/overlay.test.ts`
- Modify: `worker/index.ts:1-18`

**Interfaces:**
- Consumes: `packs.broadcast_at` column (Task 1).
- Produces: `GET /api/overlay/events?since=<cursor>` (no auth) → `200 { events: OverlayEvent[], cursor: string }` where `OverlayEvent = { packId: number, broadcastAt: string, username: string, avatarUrl: string | null, cards: { id: string, name: string, rarity: "common"|"rare"|"epic"|"legendary", imagePath: string }[] }`. Empty `since` returns `{ events: [], cursor: <server now> }` without querying broadcast history.

- [ ] **Step 1: Write the failing route test**

Create `test/routes/overlay.test.ts`:

```ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM pack_cards");
  await env.DB.exec("DELETE FROM packs");
  await env.DB.exec("DELETE FROM cards");
  await env.DB.exec("DELETE FROM users");

  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "c1",
      "Common Card",
      "common",
      "/cards/c1.png"
    ),
  ]);
});

it("returns no events and a cursor on the first load (empty since)", async () => {
  const res = await app.request("/api/overlay/events?since=", {}, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ events: unknown[]; cursor: string }>();
  expect(json.events).toEqual([]);
  expect(json.cursor).toBeTruthy();
});

it("does not include packs that were opened but never broadcast", async () => {
  const packResult = await env.DB.prepare(
    "INSERT INTO packs (user_id, opened_at) VALUES (?, CURRENT_TIMESTAMP) RETURNING id"
  )
    .bind("1")
    .first<{ id: number }>();
  await env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packResult!.id, "c1").run();

  const res = await app.request("/api/overlay/events?since=2000-01-01 00:00:00", {}, env);
  const json = await res.json<{ events: unknown[] }>();
  expect(json.events).toEqual([]);
});

it("returns a broadcast pack's cards grouped under one event", async () => {
  const packResult = await env.DB.prepare(
    "INSERT INTO packs (user_id, opened_at, broadcast_at) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id"
  )
    .bind("1")
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packResult!.id, "c1"),
    env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packResult!.id, "c1"),
  ]);

  const res = await app.request("/api/overlay/events?since=2000-01-01 00:00:00", {}, env);
  expect(res.status).toBe(200);
  const json = await res.json<{
    events: { packId: number; username: string; cards: { id: string }[] }[];
    cursor: string;
  }>();
  expect(json.events).toHaveLength(1);
  expect(json.events[0].username).toBe("viewer1");
  expect(json.events[0].cards).toHaveLength(2);
  expect(json.cursor).toBeTruthy();
});

it("only returns events broadcast after the given cursor", async () => {
  const packResult = await env.DB.prepare(
    "INSERT INTO packs (user_id, opened_at, broadcast_at) VALUES (?, CURRENT_TIMESTAMP, '2020-01-01 00:00:00') RETURNING id"
  )
    .bind("1")
    .first<{ id: number }>();
  await env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packResult!.id, "c1").run();

  const res = await app.request("/api/overlay/events?since=2025-01-01 00:00:00", {}, env);
  const json = await res.json<{ events: unknown[] }>();
  expect(json.events).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:worker -- overlay.test.ts`
Expected: FAIL — `/api/overlay/events` doesn't exist (404 on every request).

- [ ] **Step 3: Implement `worker/routes/overlay.ts`**

```ts
import { Hono } from "hono";
import type { Env, Rarity } from "../types";

const overlay = new Hono<{ Bindings: Env }>();

interface EventCardRow {
  packId: number;
  broadcastAt: string;
  username: string;
  avatarUrl: string | null;
  cardId: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
}

interface OverlayEvent {
  packId: number;
  broadcastAt: string;
  username: string;
  avatarUrl: string | null;
  cards: { id: string; name: string; rarity: Rarity; imagePath: string }[];
}

overlay.get("/events", async (c) => {
  const since = c.req.query("since") ?? "";

  if (!since) {
    const now = await c.env.DB.prepare("SELECT CURRENT_TIMESTAMP AS now").first<{ now: string }>();
    return c.json({ events: [], cursor: now!.now });
  }

  const rows = await c.env.DB.prepare(
    `SELECT p.id AS packId, p.broadcast_at AS broadcastAt, u.username, u.avatar_url AS avatarUrl,
            pc.card_id AS cardId, ca.name, ca.rarity, ca.image_path AS imagePath
     FROM packs p
     JOIN users u ON u.twitch_id = p.user_id
     JOIN pack_cards pc ON pc.pack_id = p.id
     JOIN cards ca ON ca.id = pc.card_id
     WHERE p.broadcast_at IS NOT NULL AND p.broadcast_at > ?
     ORDER BY p.broadcast_at ASC, p.id ASC, pc.rowid ASC
     LIMIT 500`
  )
    .bind(since)
    .all<EventCardRow>();

  const eventsByPackId = new Map<number, OverlayEvent>();
  for (const row of rows.results) {
    let event = eventsByPackId.get(row.packId);
    if (!event) {
      event = { packId: row.packId, broadcastAt: row.broadcastAt, username: row.username, avatarUrl: row.avatarUrl, cards: [] };
      eventsByPackId.set(row.packId, event);
    }
    event.cards.push({ id: row.cardId, name: row.name, rarity: row.rarity, imagePath: row.imagePath });
  }

  const events = [...eventsByPackId.values()].slice(0, 20);
  const cursor = events.length > 0 ? events[events.length - 1].broadcastAt : since;

  return c.json({ events, cursor });
});

export default overlay;
```

- [ ] **Step 4: Mount the route in `worker/index.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "./types";
import auth from "./routes/auth";
import webhook from "./routes/webhook";
import collection from "./routes/collection";
import trade from "./routes/trade";
import admin from "./routes/admin";
import overlay from "./routes/overlay";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", auth);
app.route("/webhook", webhook);
app.route("/api/collection", collection);
app.route("/api/trade", trade);
app.route("/api/admin", admin);
app.route("/api/overlay", overlay);

export default app;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:worker`
Expected: PASS (all suites)

- [ ] **Step 6: Commit**

```bash
git add worker/routes/overlay.ts test/routes/overlay.test.ts worker/index.ts
git commit -m "feat: add public overlay events endpoint"
```

---

### Task 3: "Cerrar y mostrar en stream" button in the pack-reveal modal

**Files:**
- Modify: `src/api.ts:48-54` (add `broadcastPack`)
- Modify: `src/collection.ts` (`revealPack`, `load`)

**Interfaces:**
- Consumes: `POST /api/collection/packs/:id/broadcast` (Task 1).
- Produces: none consumed by later tasks.

- [ ] **Step 1: Add `broadcastPack` to `src/api.ts`**

Insert right after `openPack` (after line 54):

```ts
export function broadcastPack(packId: number): Promise<{ ok: true }> {
  return request(`/collection/packs/${packId}/broadcast`, { method: "POST" });
}
```

- [ ] **Step 2: Update the import in `src/collection.ts`**

Change line 1 from:

```ts
import { getCollection, openPack, type CardView, type PendingPack } from "./api";
```

to:

```ts
import { getCollection, openPack, broadcastPack, type CardView, type PendingPack } from "./api";
```

- [ ] **Step 3: Update `revealPack` to accept a `packId` and offer both close buttons**

Replace the full `revealPack` function (lines 92-125) with:

```ts
async function revealPack(packId: number, cards: CardView[]): Promise<void> {
  const grid = document.getElementById("owned-grid")!;
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position: fixed; inset: 0; background: rgba(59,46,34,0.80); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5rem; z-index: 10; padding: 1rem; overflow-y: auto;";
  document.body.appendChild(overlay);

  const cardsRow = document.createElement("div");
  cardsRow.style.cssText = "display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 1rem;";
  overlay.appendChild(cardsRow);

  const preloads = cards.map((c) => preloadImage(c.imagePath));

  for (let i = 0; i < cards.length; i++) {
    await preloads[i];
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderCardHtml(cards[i], "", femaleVariantBaseNames, formLabels);
    const cardEl = wrapper.firstElementChild!;
    cardEl.classList.add("card-reveal");
    cardsRow.appendChild(cardEl);
    if (splitCardName(cards[i].name).isShiny) {
      new Audio("/shiny-sound.mp3").play().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const buttonsRow = document.createElement("div");
  buttonsRow.style.cssText = "display: flex; gap: 0.75rem;";

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = "Cerrar";
  closeBtn.addEventListener("click", () => overlay.remove());

  const broadcastBtn = document.createElement("button");
  broadcastBtn.className = "btn";
  broadcastBtn.textContent = "Cerrar y mostrar en stream";
  broadcastBtn.addEventListener("click", async () => {
    broadcastBtn.disabled = true;
    try {
      await broadcastPack(packId);
      overlay.remove();
    } catch {
      broadcastBtn.disabled = false;
      broadcastBtn.textContent = "Error, reintentar";
    }
  });

  buttonsRow.appendChild(closeBtn);
  buttonsRow.appendChild(broadcastBtn);
  overlay.appendChild(buttonsRow);

  grid.dispatchEvent(new Event("reload-collection"));
}
```

- [ ] **Step 4: Pass `packId` through in `load()`**

In the `load` function, change the `renderPendingPacks` callback (around line 137-141) from:

```ts
  renderPendingPacks(data.pendingPacks, async (packId, generation) => {
    const result = await openPack(packId, generation);
    await revealPack(result.cards);
    await load();
  });
```

to:

```ts
  renderPendingPacks(data.pendingPacks, async (packId, generation) => {
    const result = await openPack(packId, generation);
    await revealPack(packId, result.cards);
    await load();
  });
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no errors

- [ ] **Step 6: Manual check**

Run: `npm run dev`, open `/collection.html`, open a pending pack (grant yourself one via `/admin.html` if none pending), confirm both buttons appear after the reveal animation, and that clicking "Cerrar y mostrar en stream" closes the modal without error (verify via Network tab that `POST /api/collection/packs/:id/broadcast` returns 200).

- [ ] **Step 7: Commit**

```bash
git add src/api.ts src/collection.ts
git commit -m "feat: add stream-broadcast option to pack reveal"
```

---

### Task 4: Overlay page (`overlay.html` + `src/overlay.ts`)

**Files:**
- Create: `overlay.html`
- Create: `src/overlay.ts`
- Modify: `src/style.css` (append overlay styles)
- Modify: `vite.config.ts:5-23` (register the new page as a build entry)

**Interfaces:**
- Consumes: `GET /api/overlay/events?since=<cursor>` (Task 2), `renderCardHtml` from `src/card.ts`, `CardView` from `src/api.ts`.
- Produces: none consumed by later tasks (last task in this plan).

- [ ] **Step 1: Create `overlay.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Russo+One&family=Quicksand:wght@500;700&family=JetBrains+Mono:wght@600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/src/style.css" />
    <title>Overlay</title>
  </head>
  <body class="overlay-body">
    <div id="alerts"></div>
    <script type="module" src="/src/overlay.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Append overlay styles to `src/style.css`**

```css

/* Overlay alerts (OBS Browser Source) */
.overlay-body { background: transparent; }

#alerts {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 2rem;
  pointer-events: none;
}

.overlay-alert {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  background: var(--surface);
  border: 2px solid var(--gold);
  border-radius: 16px;
  padding: 1rem 1.5rem;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  animation: overlay-alert-in 0.4s ease both;
}

.overlay-alert-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.overlay-alert-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
}

.overlay-alert-username {
  font-family: 'Russo One', sans-serif;
  color: var(--text-em);
}

.overlay-alert-cards {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem;
}

@keyframes overlay-alert-in {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 3: Create `src/overlay.ts`**

```ts
import { renderCardHtml } from "./card";
import type { CardView } from "./api";

interface OverlayEventCard {
  id: string;
  name: string;
  rarity: CardView["rarity"];
  imagePath: string;
}

interface OverlayEvent {
  packId: number;
  broadcastAt: string;
  username: string;
  avatarUrl: string | null;
  cards: OverlayEventCard[];
}

const POLL_INTERVAL_MS = 4000;
const ALERT_DURATION_MS = 6000;

let cursor = "";
const queue: OverlayEvent[] = [];
let showing = false;

function toCardView(card: OverlayEventCard): CardView {
  return { id: card.id, name: card.name, rarity: card.rarity, imagePath: card.imagePath, quantity: 1, generation: 0 };
}

function showNextAlert(): void {
  if (showing) return;
  const event = queue.shift();
  if (!event) return;
  showing = true;

  const alertEl = document.createElement("div");
  alertEl.className = "overlay-alert";
  alertEl.innerHTML = `
    <div class="overlay-alert-header">
      <img class="overlay-alert-avatar" src="${event.avatarUrl ?? "/favicon.png"}" alt="" />
      <span class="overlay-alert-username">${event.username}</span>
    </div>
    <div class="overlay-alert-cards">
      ${event.cards.map((c) => renderCardHtml(toCardView(c))).join("")}
    </div>
  `;
  document.getElementById("alerts")!.appendChild(alertEl);

  setTimeout(() => {
    alertEl.remove();
    showing = false;
    showNextAlert();
  }, ALERT_DURATION_MS);
}

async function poll(): Promise<void> {
  try {
    const res = await fetch(`/api/overlay/events?since=${encodeURIComponent(cursor)}`);
    if (!res.ok) return;
    const data = (await res.json()) as { events: OverlayEvent[]; cursor: string };
    cursor = data.cursor;
    queue.push(...data.events);
    showNextAlert();
  } catch {
    // ignore, retry on the next interval
  }
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
```

- [ ] **Step 4: Register `overlay.html` as a Vite build entry**

Replace `vite.config.ts` with:

```ts
import path from "node:path";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, "index.html"),
            collection: path.resolve(__dirname, "collection.html"),
            trade: path.resolve(__dirname, "trade.html"),
            offers: path.resolve(__dirname, "offers.html"),
            album: path.resolve(__dirname, "album.html"),
            admin: path.resolve(__dirname, "admin.html"),
            overlay: path.resolve(__dirname, "overlay.html"),
          },
        },
      },
    },
  },
});
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no errors

- [ ] **Step 6: Manual end-to-end check**

Run: `npm run dev`. Open `/overlay.html` in one tab and `/collection.html` in another (logged in). Open a pending pack in the collection tab and click "Cerrar y mostrar en stream". Within ~4 seconds, confirm the alert (avatar, username, cards styled with the site's rarity borders) appears in the overlay tab and disappears after ~6 seconds. Open a second pack and confirm the two alerts queue instead of overlapping.

- [ ] **Step 7: Commit**

```bash
git add overlay.html src/overlay.ts src/style.css vite.config.ts
git commit -m "feat: add OBS overlay page for pack-opening alerts"
```

---

## Self-Review Notes

- Spec coverage: `broadcast_at` column + authenticated set-broadcast endpoint (Task 1), public polling endpoint with empty-cursor bootstrap and no-replay-on-first-load behavior (Task 2), the two-button reveal modal (Task 3), the OBS page itself reusing existing card rendering and rarity styling (Task 4) — every spec section has a task.
- No rarity filter is implemented, matching the spec's explicit "fuera de alcance"; the endpoint already returns per-card `rarity`, so a future filter is a client-side change in `src/overlay.ts` only.
- No global settings/toggle, no WebSockets/Durable Objects — confirmed absent from every task.
