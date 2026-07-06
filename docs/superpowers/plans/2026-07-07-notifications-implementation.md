# Notifications System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable, generic notification system (bell icon in the header, dropdown panel, unread marker) that any backend subsystem can push text messages into via a single `notify()` call.

**Architecture:** One new D1 table (`notifications`), one backend helper (`worker/lib/notifications.ts`) any route handler can call directly, one route file (`worker/routes/notifications.ts`) exposing `GET /unread` and `GET /` to the frontend, and one frontend module (`src/notifications.ts`) that renders the bell + panel and wires into the existing `initUserHeader()`.

**Tech Stack:** Hono (routes), D1 (SQL), vanilla TypeScript (frontend), Vitest (`vitest.workers.config.ts` for anything touching `c.env.DB`, `vitest.config.ts` for pure frontend functions).

## Global Constraints

- Max 20 notifications retained per user — oldest deleted permanently on overflow (from spec, non-negotiable).
- Opening the panel marks ALL of that user's notifications as read (from spec).
- Unread marker is a plain dot (reuse existing `.notif-dot` visual style), not a count.
- Do not touch the existing trade "pending offer" dot-badge (`/api/trade/offers/pending-count`) — stays independent.
- Bell sits immediately to the left of `#user-name` in `.page-header-user`, on every page that calls `initUserHeader()` (`collection.html`, `trade.html`, `album.html`, `offers.html`). Not on `admin.html` (doesn't call `initUserHeader()`).
- Spec: `docs/superpowers/specs/2026-07-07-notifications-design.md`.

---

### Task 1: `notify()` helper + notifications table

**Files:**
- Create: `migrations/0020_notifications.sql`
- Create: `worker/lib/notifications.ts`
- Test: `worker/lib/notifications.test.ts`

**Interfaces:**
- Produces: `notify(env: Env, userId: string, message: string, link?: string): Promise<void>` — insert-only helper, no HTTP route. Later tasks (routes, and the future marketplace plan) import this directly.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0020_notifications.sql
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  message TEXT NOT NULL,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
```

`vitest.workers.config.ts` auto-applies every file in `migrations/` before tests run (via `readD1Migrations` + `test/apply-migrations.ts`) — no other config change needed for tests to see this table.

- [ ] **Step 2: Write the failing test**

```ts
// worker/lib/notifications.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import { notify } from "./notifications";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM notifications");
  await env.DB.exec("DELETE FROM users");
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();
});

it("inserts a notification for a user", async () => {
  await notify(env, "1", "hello");
  const row = await env.DB.prepare("SELECT message, link, read FROM notifications WHERE user_id = ?")
    .bind("1")
    .first<{ message: string; link: string | null; read: number }>();
  expect(row).toEqual({ message: "hello", link: null, read: 0 });
});

it("stores an optional link", async () => {
  await notify(env, "1", "hello", "/somewhere");
  const row = await env.DB.prepare("SELECT link FROM notifications WHERE user_id = ?")
    .bind("1")
    .first<{ link: string }>();
  expect(row?.link).toBe("/somewhere");
});

it("keeps only the 20 most recent notifications per user, deleting the oldest on overflow", async () => {
  for (let i = 0; i < 25; i++) {
    await notify(env, "1", `message ${i}`);
  }
  const rows = await env.DB.prepare("SELECT message FROM notifications WHERE user_id = ? ORDER BY id ASC")
    .bind("1")
    .all<{ message: string }>();
  expect(rows.results).toHaveLength(20);
  expect(rows.results[0].message).toBe("message 5");
  expect(rows.results[19].message).toBe("message 24");
});

it("does not delete other users' notifications when purging overflow", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2").run();
  await notify(env, "2", "keep me");
  for (let i = 0; i < 25; i++) {
    await notify(env, "1", `message ${i}`);
  }
  const row = await env.DB.prepare("SELECT message FROM notifications WHERE user_id = ?")
    .bind("2")
    .first<{ message: string }>();
  expect(row?.message).toBe("keep me");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run worker/lib/notifications.test.ts --config vitest.workers.config.ts`
Expected: FAIL — `Cannot find module './notifications'` (file doesn't exist yet).

- [ ] **Step 4: Write minimal implementation**

```ts
// worker/lib/notifications.ts
import type { Env } from "../types";

export async function notify(env: Env, userId: string, message: string, link?: string): Promise<void> {
  await env.DB.prepare("INSERT INTO notifications (user_id, message, link) VALUES (?, ?, ?)")
    .bind(userId, message, link ?? null)
    .run();

  await env.DB.prepare(
    `DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
      SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20
    )`
  )
    .bind(userId, userId)
    .run();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run worker/lib/notifications.test.ts --config vitest.workers.config.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add migrations/0020_notifications.sql worker/lib/notifications.ts worker/lib/notifications.test.ts
git commit -m "feat: add notify() helper with 20-notification cap per user"
```

---

### Task 2: `/api/notifications` routes

**Files:**
- Create: `worker/routes/notifications.ts`
- Modify: `worker/index.ts`
- Test: `test/routes/notifications.test.ts`

**Interfaces:**
- Consumes: `notify(env, userId, message, link?)` from Task 1.
- Produces: `GET /api/notifications/unread` → `{ unread: boolean }`. `GET /api/notifications` → `{ notifications: { id: number; message: string; link: string | null; read: boolean; createdAt: string }[] }`, marks all as read as a side effect. Later frontend tasks rely on this exact shape (camelCase `createdAt`, `link` nullable).

- [ ] **Step 1: Write the failing test**

```ts
// test/routes/notifications.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";
import { notify } from "../../worker/lib/notifications";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM notifications");
  await env.DB.exec("DELETE FROM users");
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();
});

it("reports no unread notifications when there are none", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/notifications/unread", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ unread: false });
});

it("reports unread notifications after one is created", async () => {
  await notify(env, "1", "hello");
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/notifications/unread", { headers: { Cookie: cookie } }, env);
  expect(await res.json()).toEqual({ unread: true });
});

it("lists notifications newest first and includes the link", async () => {
  await notify(env, "1", "first");
  await notify(env, "1", "second", "/somewhere");
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/notifications", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ notifications: { message: string; link: string | null }[] }>();
  expect(json.notifications.map((n) => n.message)).toEqual(["second", "first"]);
  expect(json.notifications[0].link).toBe("/somewhere");
  expect(json.notifications[1].link).toBeNull();
});

it("marks all notifications as read as a side effect of listing them", async () => {
  await notify(env, "1", "hello");
  const cookie = await sessionCookie("1", "viewer1");

  await app.request("/api/notifications", { headers: { Cookie: cookie } }, env);

  const unreadRes = await app.request("/api/notifications/unread", { headers: { Cookie: cookie } }, env);
  expect(await unreadRes.json()).toEqual({ unread: false });
});

it("only returns notifications belonging to the current user", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2").run();
  await notify(env, "2", "not for you");
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/notifications", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ notifications: unknown[] }>();
  expect(json.notifications).toHaveLength(0);
});

it("rejects unauthenticated requests", async () => {
  const res = await app.request("/api/notifications/unread", {}, env);
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/notifications.test.ts --config vitest.workers.config.ts`
Expected: FAIL — 404s (route doesn't exist / not mounted).

- [ ] **Step 3: Write minimal implementation**

```ts
// worker/routes/notifications.ts
import { Hono } from "hono";
import type { Env, SessionUser } from "../types";
import { requireAuth } from "../middleware/auth";

const notifications = new Hono<{ Bindings: Env; Variables: { user: SessionUser } }>();

interface NotificationRow {
  id: number;
  message: string;
  link: string | null;
  read: number;
  created_at: string;
}

notifications.get("/unread", requireAuth, async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND read = 0 LIMIT 1")
    .bind(user.twitchId)
    .first();
  return c.json({ unread: row !== null });
});

notifications.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const rows = await c.env.DB.prepare(
    "SELECT id, message, link, read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20"
  )
    .bind(user.twitchId)
    .all<NotificationRow>();

  await c.env.DB.prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0")
    .bind(user.twitchId)
    .run();

  return c.json({
    notifications: rows.results.map((r) => ({
      id: r.id,
      message: r.message,
      link: r.link,
      read: Boolean(r.read),
      createdAt: r.created_at,
    })),
  });
});

export default notifications;
```

```ts
// worker/index.ts — add import + mount
import notifications from "./routes/notifications";
// ...
app.route("/api/notifications", notifications);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/routes/notifications.test.ts --config vitest.workers.config.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add worker/routes/notifications.ts worker/index.ts test/routes/notifications.test.ts
git commit -m "feat: add /api/notifications routes"
```

---

### Task 3: Frontend API client

**Files:**
- Modify: `src/api.ts`

**Interfaces:**
- Produces: `NotificationView { id: number; message: string; link: string | null; read: boolean; createdAt: string }`, `getUnreadNotifications(): Promise<{ unread: boolean }>`, `listNotifications(): Promise<{ notifications: NotificationView[] }>`. Task 4 imports these.

- [ ] **Step 1: Add types and functions to `src/api.ts`**

Append at the end of the file (after `claimDailyPack`):

```ts
export interface NotificationView {
  id: number;
  message: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export function getUnreadNotifications(): Promise<{ unread: boolean }> {
  return request("/notifications/unread");
}

export function listNotifications(): Promise<{ notifications: NotificationView[] }> {
  return request("/notifications");
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat: add notifications API client functions"
```

---

### Task 4: Bell icon, dropdown panel, and header wiring

**Files:**
- Create: `src/notifications.ts`
- Test: `src/notifications.test.ts`
- Modify: `src/user-header.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `getUnreadNotifications`, `listNotifications`, `NotificationView` from Task 3.
- Produces: `renderNotificationList(items: NotificationView[]): string` (pure, tested directly), `initNotifications(headerUser: Element): void` (DOM wiring, not unit-tested — matches how `initUserHeader` itself isn't unit-tested in this codebase).

- [ ] **Step 1: Write the failing test for the pure render function**

```ts
// src/notifications.test.ts
import { describe, it, expect } from "vitest";
import { renderNotificationList } from "./notifications";

describe("renderNotificationList", () => {
  it("renders a placeholder when there are no notifications", () => {
    expect(renderNotificationList([])).toContain("Sin notificaciones");
  });

  it("renders a notification without a link as a non-clickable div", () => {
    const html = renderNotificationList([
      { id: 1, message: "Hola", link: null, read: false, createdAt: "2026-01-01" },
    ]);
    expect(html).toContain("<div");
    expect(html).toContain("Hola");
    expect(html).not.toContain("<a");
  });

  it("renders a notification with a link as a clickable anchor", () => {
    const html = renderNotificationList([
      {
        id: 2,
        message: "Oferta aceptada",
        link: "/marketplace.html?tab=mine",
        read: false,
        createdAt: "2026-01-01",
      },
    ]);
    expect(html).toContain('<a class="notif-item" href="/marketplace.html?tab=mine"');
    expect(html).toContain("Oferta aceptada");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/notifications.test.ts`
Expected: FAIL — `Cannot find module './notifications'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/notifications.ts
import { getUnreadNotifications, listNotifications, type NotificationView } from "./api";

export function renderNotificationList(items: NotificationView[]): string {
  if (items.length === 0) return `<p class="notif-empty">Sin notificaciones</p>`;
  return items
    .map((n) => {
      const tag = n.link ? "a" : "div";
      const href = n.link ? ` href="${n.link}"` : "";
      return `<${tag} class="notif-item"${href} data-id="${n.id}">${n.message}</${tag}>`;
    })
    .join("");
}

export function initNotifications(headerUser: Element): void {
  const bellBtn = document.createElement("button");
  bellBtn.className = "icon-btn notif-bell";
  bellBtn.type = "button";
  bellBtn.setAttribute("aria-haspopup", "true");
  bellBtn.setAttribute("aria-expanded", "false");
  bellBtn.setAttribute("aria-label", "Notificaciones");
  bellBtn.textContent = "🔔";

  const dot = document.createElement("span");
  dot.className = "notif-dot";
  dot.hidden = true;
  bellBtn.appendChild(dot);

  const panel = document.createElement("div");
  panel.className = "notif-panel";
  panel.hidden = true;

  const userName = headerUser.querySelector("#user-name");
  headerUser.insertBefore(bellBtn, userName);
  headerUser.insertBefore(panel, userName);

  const close = () => {
    panel.hidden = true;
    bellBtn.setAttribute("aria-expanded", "false");
  };
  const open = async () => {
    panel.hidden = false;
    bellBtn.setAttribute("aria-expanded", "true");
    dot.hidden = true;
    const { notifications } = await listNotifications();
    panel.innerHTML = renderNotificationList(notifications);
  };

  bellBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.hidden) open();
    else close();
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node) && e.target !== bellBtn) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  getUnreadNotifications().then(({ unread }) => {
    dot.hidden = !unread;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/notifications.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire into `user-header.ts`**

In `src/user-header.ts`, add the import at the top:

```ts
import { initNotifications } from "./notifications";
```

Inside the existing `if (headerUser) { ... }` block (right after the `headerUser.insertBefore(muteBtn, headerUser.firstChild);` line), add:

```ts
    initNotifications(headerUser);
```

- [ ] **Step 6: Add CSS**

Append to `src/style.css` (near the existing `.notif-dot` rule):

```css
.notif-bell {
  position: relative;
}
/* position: fixed (not absolute) — .page-header sets overflow-x: auto, which per
   spec forces overflow-y to compute to auto too, so an absolutely-positioned
   dropdown anchored inside .page-header-user would get clipped/scrolled inside
   the header instead of floating over the page. .howto-fab sidesteps the same
   issue by also using position: fixed. */
.notif-panel {
  position: fixed;
  top: 3.6rem;
  right: 1rem;
  z-index: 45;
  min-width: 260px;
  max-width: min(90vw, 340px);
  max-height: 60vh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.5rem;
  box-shadow: 0 6px 20px rgba(120, 90, 60, 0.25);
}
.notif-item {
  display: block;
  padding: 0.5rem 0.6rem;
  font-size: 0.8rem;
  color: var(--text);
  text-decoration: none;
  border-bottom: 1px solid var(--border);
}
.notif-item:last-child {
  border-bottom: none;
}
a.notif-item:hover {
  color: var(--text-em);
}
.notif-empty {
  padding: 0.5rem 0.6rem;
  font-size: 0.8rem;
  color: var(--muted);
}
```

- [ ] **Step 7: Type-check and run full test suite**

Run: `npx tsc --noEmit && npm test && npm run test:worker`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/notifications.ts src/notifications.test.ts src/user-header.ts src/style.css
git commit -m "feat: add notification bell and dropdown panel to the header"
```

---

### Task 5: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Confirm the bell renders with no unread state**

Open `/collection.html` logged in. Confirm a 🔔 button appears immediately left of your username, with no red dot.

- [ ] **Step 3: Confirm open/close behavior**

Click the bell — panel opens showing "Sin notificaciones". Click outside — panel closes. Re-open, press `Escape` — panel closes.

- [ ] **Step 4: Manually insert a notification and confirm the dot + list**

Find your `twitch_id` (e.g. `npx wrangler d1 execute twitch-cards-db --local --command "SELECT twitch_id, username FROM users"`), then:

```bash
npx wrangler d1 execute twitch-cards-db --local --command "INSERT INTO notifications (user_id, message, link) VALUES ('<your_twitch_id>', 'Test notification', '/collection.html')"
```

Reload `/collection.html` — red dot appears on the bell. Click it — panel shows "Test notification" as a clickable link, dot disappears immediately (before the fetch even resolves, per Step 3 `open()` logic). Reload again — dot stays gone (already marked read).

- [ ] **Step 5: Confirm the bell appears on every page that has it, and not on admin**

Check `/trade.html`, `/album.html`, `/offers.html` (all show the bell) and `/admin.html` (no bell — doesn't call `initUserHeader()`).
