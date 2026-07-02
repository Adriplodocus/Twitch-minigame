# Admin Grant-Packs Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a password-gated `/admin.html` panel where the streamer can search for a registered user by Twitch username and grant them 1-50 blísters (pack rows), with a confirmation step and a visible history of admin-granted packs.

**Architecture:** New Hono sub-app `worker/routes/admin.ts` mounted at `/api/admin`, guarded by a new `requireAdmin` middleware that checks a separate `admin_session` JWT cookie (distinct from the player `session` cookie). A new `packs.source` column (`'reward' | 'admin'`) distinguishes webhook-granted packs from admin-granted ones. Frontend is a new static page (`admin.html` + `src/admin.ts`) following the existing multi-page Vite pattern used by `collection.html`/`trade.html`/`album.html`.

**Tech Stack:** Hono, Cloudflare Workers + D1, `jose` (JWT), Vite multi-page build, Vitest + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Admin password lives in a Worker secret `ADMIN_PASSWORD` (env var in dev via `.dev.vars`), never hardcoded.
- Admin session cookie name: `admin_session`. Player session cookie (`session`) and admin session must never authenticate each other's routes.
- `grant-packs` quantity must be an integer between 1 and 50 inclusive; otherwise 400.
- `packs.source` values are exactly `'reward'` or `'admin'`; existing webhook insert path must keep defaulting to `'reward'` without code changes to `webhook.ts`.
- No UI navigation link to `/admin.html` from any other page (URL-only access).
- Follow existing code style: inline `style="..."` attributes for one-off layout (as in `collection.html`/`trade.html`), reuse `.btn`/`.input`/`.badge`/`.card` classes from `src/style.css` — no new CSS classes needed for this feature.

---

### Task 1: `packs.source` column

**Files:**
- Create: `migrations/0005_pack_source.sql`
- Modify: `test/routes/webhook.test.ts`

**Interfaces:**
- Produces: `packs.source TEXT NOT NULL DEFAULT 'reward' CHECK (source IN ('reward', 'admin'))` — every later task that inserts into `packs` can rely on this column existing.

- [ ] **Step 1: Write the failing test**

Add this test to `test/routes/webhook.test.ts` (append after the existing `"creates a pending pack..."` test):

```ts
it("defaults new pack rows to source 'reward'", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
    event: {
      user_id: "42",
      user_login: "mrklypp",
      user_name: "mrklypp",
      reward: { id: "reward-1" },
    },
  });
  const messageId = "msg-source-1";
  const timestamp = new Date().toISOString();
  const signature = await signBody(messageId, timestamp, body);

  await app.request(
    "/webhook/eventsub",
    {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": signature,
        "Twitch-Eventsub-Message-Type": "notification",
      },
    },
    env
  );

  const pack = await env.DB.prepare("SELECT source FROM packs WHERE user_id = ?")
    .bind("42")
    .first<{ source: string }>();
  expect(pack?.source).toBe("reward");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:worker -- webhook`
Expected: FAIL with a SQLite error like `no such column: source`

- [ ] **Step 3: Add the migration**

Create `migrations/0005_pack_source.sql`:

```sql
ALTER TABLE packs ADD COLUMN source TEXT NOT NULL DEFAULT 'reward'
  CHECK (source IN ('reward', 'admin'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:worker -- webhook`
Expected: PASS (all tests in `webhook.test.ts`, including the new one)

- [ ] **Step 5: Commit**

```bash
git add migrations/0005_pack_source.sql test/routes/webhook.test.ts
git commit -m "feat: add packs.source column for reward vs admin grants"
```

---

### Task 2: Admin session JWT helpers

**Files:**
- Modify: `worker/lib/jwt.ts`
- Modify: `test/lib/jwt.test.ts`

**Interfaces:**
- Consumes: `getKey(secret: string): Uint8Array` (already in `worker/lib/jwt.ts`, unexported — reuse it directly since these functions live in the same file).
- Produces: `signAdminSession(secret: string): Promise<string>` and `verifyAdminSession(token: string, secret: string): Promise<boolean>` — Task 3's `requireAdmin` middleware and `admin.ts` routes call these.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib/jwt.test.ts`:

```ts
import { signAdminSession, verifyAdminSession } from "../../worker/lib/jwt";

it("round-trips a signed admin session", async () => {
  const token = await signAdminSession(SECRET);
  const valid = await verifyAdminSession(token, SECRET);
  expect(valid).toBe(true);
});

it("rejects an admin session signed with a different secret", async () => {
  const token = await signAdminSession(SECRET);
  const valid = await verifyAdminSession(token, "a-completely-different-secret");
  expect(valid).toBe(false);
});

it("rejects a malformed admin session token", async () => {
  const valid = await verifyAdminSession("not-a-jwt", SECRET);
  expect(valid).toBe(false);
});

it("does not accept a player session token as an admin session", async () => {
  const playerToken = await signSession({ twitchId: "123", username: "mrklypp" }, SECRET);
  const valid = await verifyAdminSession(playerToken, SECRET);
  expect(valid).toBe(false);
});
```

(Note: the existing `import { signSession, verifySession } from "../../worker/lib/jwt";` at the top of the file already brings in `signSession` — just add `signAdminSession, verifyAdminSession` to that same import line instead of a second import statement.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:worker -- jwt`
Expected: FAIL with `signAdminSession is not a function` (or a TypeScript import error)

- [ ] **Step 3: Implement the functions**

Add to `worker/lib/jwt.ts` (after the existing `verifySession` function):

```ts
export async function signAdminSession(secret: string): Promise<string> {
  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getKey(secret));
}

export async function verifyAdminSession(token: string, secret: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, getKey(secret));
    return payload.role === "admin";
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:worker -- jwt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/lib/jwt.ts test/lib/jwt.test.ts
git commit -m "feat: add admin session JWT sign/verify helpers"
```

---

### Task 3: Admin auth middleware + routes

**Files:**
- Modify: `worker/types.ts` (add `ADMIN_PASSWORD: string;` to `Env`)
- Modify: `worker/middleware/auth.ts` (add `requireAdmin`)
- Create: `worker/routes/admin.ts`
- Modify: `worker/index.ts` (mount the new route)
- Modify: `.dev.vars` (add `ADMIN_PASSWORD=test-admin-password`)
- Modify: `.dev.vars.example` (add `ADMIN_PASSWORD=`)
- Create: `test/routes/admin.test.ts`

**Interfaces:**
- Consumes: `signAdminSession`/`verifyAdminSession` from Task 2; `Env` from `worker/types.ts`.
- Produces: `requireAdmin` middleware (importable from `worker/middleware/auth.ts`, same shape as `requireAuth`); routes `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/users?q=`, `POST /api/admin/grant-packs`, `GET /api/admin/history` — Task 4's frontend calls these exact paths with these exact request/response shapes:
  - `POST /login` body `{ password: string }` → 200 `{ ok: true }` (sets `admin_session` cookie) or 401 `{ error: string }`.
  - `POST /logout` → 200 `{ ok: true }` (clears cookie).
  - `GET /users?q=<text>` → 200 `{ users: { twitchId: string; username: string; avatarUrl: string | null }[] }`.
  - `POST /grant-packs` body `{ twitchId: string; quantity: number }` → 200 `{ ok: true }`, 400 `{ error: string }` (bad quantity), 404 `{ error: string }` (unknown user).
  - `GET /history` → 200 `{ history: { id: number; userId: string; username: string; createdAt: string }[] }`.

- [ ] **Step 1: Write the failing test file**

Create `test/routes/admin.test.ts`:

```ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signAdminSession, signSession } from "../../worker/lib/jwt";

async function adminCookie(): Promise<string> {
  const token = await signAdminSession(env.JWT_SECRET);
  return `admin_session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM packs");
  await env.DB.exec("DELETE FROM users");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1"),
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2"),
  ]);
});

it("rejects login with the wrong password", async () => {
  const res = await app.request(
    "/api/admin/login",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }) },
    env
  );
  expect(res.status).toBe(401);
});

it("accepts login with the correct password and sets a cookie", async () => {
  const res = await app.request(
    "/api/admin/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    },
    env
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("admin_session=");
});

it("requires an admin session for protected routes", async () => {
  const res = await app.request("/api/admin/users?q=viewer", {}, env);
  expect(res.status).toBe(401);
});

it("rejects a player session cookie on admin routes", async () => {
  const token = await signSession({ twitchId: "1", username: "viewer1" }, env.JWT_SECRET);
  const res = await app.request("/api/admin/users?q=viewer", { headers: { Cookie: `session=${token}` } }, env);
  expect(res.status).toBe(401);
});

it("searches users by username", async () => {
  const cookie = await adminCookie();
  const res = await app.request("/api/admin/users?q=viewer1", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ users: { twitchId: string; username: string }[] }>();
  expect(json.users).toHaveLength(1);
  expect(json.users[0].username).toBe("viewer1");
});

it("rejects grant-packs with an out-of-range quantity", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 0 }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects grant-packs for a nonexistent user", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "does-not-exist", quantity: 1 }),
    },
    env
  );
  expect(res.status).toBe(404);
});

it("grants packs with source 'admin' and lists them in history", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 3 }),
    },
    env
  );
  expect(res.status).toBe(200);

  const packs = await env.DB.prepare("SELECT source FROM packs WHERE user_id = ?").bind("1").all<{ source: string }>();
  expect(packs.results).toHaveLength(3);
  expect(packs.results.every((p) => p.source === "admin")).toBe(true);

  const historyRes = await app.request("/api/admin/history", { headers: { Cookie: cookie } }, env);
  const historyJson = await historyRes.json<{ history: { username: string }[] }>();
  expect(historyJson.history).toHaveLength(3);
  expect(historyJson.history[0].username).toBe("viewer1");
});

it("logs out by clearing the admin session cookie", async () => {
  const res = await app.request("/api/admin/logout", { method: "POST" }, env);
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("admin_session=");
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npm run test:worker -- admin`
Expected: FAIL with a module-not-found error for `worker/routes/admin.ts` (and `env.ADMIN_PASSWORD` being `undefined`)

- [ ] **Step 3: Add `ADMIN_PASSWORD` to the Env type and dev vars**

In `worker/types.ts`, add to the `Env` interface (after `JWT_SECRET: string;`):

```ts
  ADMIN_PASSWORD: string;
```

Append to `.dev.vars`:

```
ADMIN_PASSWORD=test-admin-password
```

Append to `.dev.vars.example`:

```
ADMIN_PASSWORD=
```

- [ ] **Step 4: Add `requireAdmin` middleware**

In `worker/middleware/auth.ts`, add (after the existing `requireAuth` export), and extend the top imports to include `verifyAdminSession`:

```ts
import { verifySession, verifyAdminSession } from "../lib/jwt";
```

```ts
export const requireAdmin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = getCookie(c, "admin_session");
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const valid = await verifyAdminSession(token, c.env.JWT_SECRET);
  if (!valid) return c.json({ error: "Unauthorized" }, 401);
  await next();
});
```

- [ ] **Step 5: Create the admin routes**

Create `worker/routes/admin.ts`:

```ts
import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { requireAdmin } from "../middleware/auth";
import { signAdminSession } from "../lib/jwt";

const admin = new Hono<{ Bindings: Env }>();

admin.post("/login", async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  if (!body.password || body.password !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "Invalid password" }, 401);
  }
  const token = await signAdminSession(c.env.JWT_SECRET);
  setCookie(c, "admin_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.json({ ok: true });
});

admin.post("/logout", (c) => {
  deleteCookie(c, "admin_session", { path: "/" });
  return c.json({ ok: true });
});

admin.get("/users", requireAdmin, async (c) => {
  const q = c.req.query("q") ?? "";
  const users = await c.env.DB.prepare(
    `SELECT twitch_id AS twitchId, username, avatar_url AS avatarUrl
     FROM users WHERE username LIKE ? ORDER BY username LIMIT 10`
  )
    .bind(`%${q}%`)
    .all<{ twitchId: string; username: string; avatarUrl: string | null }>();
  return c.json({ users: users.results });
});

admin.post("/grant-packs", requireAdmin, async (c) => {
  const body = await c.req
    .json<{ twitchId?: string; quantity?: number }>()
    .catch(() => ({}) as { twitchId?: string; quantity?: number });
  const { twitchId, quantity } = body;

  if (!twitchId || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return c.json({ error: "Invalid twitchId or quantity" }, 400);
  }

  const user = await c.env.DB.prepare("SELECT twitch_id FROM users WHERE twitch_id = ?").bind(twitchId).first();
  if (!user) return c.json({ error: "User not found" }, 404);

  const statements = Array.from({ length: quantity }, () =>
    c.env.DB.prepare("INSERT INTO packs (user_id, source) VALUES (?, 'admin')").bind(twitchId)
  );
  await c.env.DB.batch(statements);

  return c.json({ ok: true });
});

admin.get("/history", requireAdmin, async (c) => {
  const history = await c.env.DB.prepare(
    `SELECT p.id, p.user_id AS userId, u.username, p.created_at AS createdAt
     FROM packs p JOIN users u ON u.twitch_id = p.user_id
     WHERE p.source = 'admin'
     ORDER BY p.created_at DESC LIMIT 20`
  ).all<{ id: number; userId: string; username: string; createdAt: string }>();
  return c.json({ history: history.results });
});

export default admin;
```

- [ ] **Step 6: Mount the route in `worker/index.ts`**

```ts
import admin from "./routes/admin";
```

```ts
app.route("/api/admin", admin);
```

- [ ] **Step 7: Run the test file to verify it passes**

Run: `npm run test:worker -- admin`
Expected: PASS (all 9 tests)

- [ ] **Step 8: Run the full worker test suite to check for regressions**

Run: `npm run test:worker`
Expected: PASS (all files, including `webhook.test.ts`, `jwt.test.ts`, `collection.test.ts`, `auth.test.ts`, `trade.test.ts`)

- [ ] **Step 9: Commit**

```bash
git add worker/types.ts worker/middleware/auth.ts worker/routes/admin.ts worker/index.ts .dev.vars .dev.vars.example test/routes/admin.test.ts
git commit -m "feat: add admin auth, user search, grant-packs, and history routes"
```

---

### Task 4: Admin frontend page

**Files:**
- Create: `admin.html`
- Create: `src/admin.ts`
- Modify: `vite.config.ts` (add `admin` entry)

**Interfaces:**
- Consumes: the five `/api/admin/*` endpoints from Task 3, exact shapes as documented there.
- Produces: a working page at `/admin.html`. Nothing else depends on this task's output.

- [ ] **Step 1: Register the new Vite entry**

In `vite.config.ts`, add `admin` to `rollupOptions.input`:

```ts
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, "index.html"),
            collection: path.resolve(__dirname, "collection.html"),
            trade: path.resolve(__dirname, "trade.html"),
            album: path.resolve(__dirname, "album.html"),
            admin: path.resolve(__dirname, "admin.html"),
          },
        },
```

- [ ] **Step 2: Create `admin.html`**

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
    <title>Admin</title>
  </head>
  <body>
    <div class="container" style="padding: 2rem 1rem;">
      <h1>Admin</h1>

      <div id="login-view" style="margin-top: 1.5rem; max-width: 320px;">
        <input class="input" id="login-password" type="password" placeholder="Clave" style="width: 100%;" />
        <button class="btn" id="login-btn" style="margin-top: 0.75rem;">Entrar</button>
        <p id="login-error" style="color: #C2477F; margin-top: 0.5rem; display: none;"></p>
      </div>

      <div id="panel-view" style="display: none; margin-top: 1.5rem;">
        <button class="btn" id="logout-btn">Cerrar sesión</button>

        <div style="margin-top: 1.5rem;">
          <h2>Dar blíster</h2>
          <input
            class="input"
            id="search-input"
            placeholder="Buscar username de Twitch"
            style="margin-top: 0.75rem; width: 100%; max-width: 320px;"
          />
          <div id="search-results" style="margin-top: 0.5rem;"></div>

          <div id="selected-user" style="display: none; margin-top: 0.75rem; align-items: center; gap: 0.5rem;">
            <span class="badge" id="selected-user-name"></span>
            <button class="btn" id="clear-selection-btn" style="padding: 0.3rem 0.8rem;">x</button>
          </div>

          <div style="margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">
            <input class="input" id="quantity-input" type="number" min="1" max="50" value="1" style="width: 80px;" />
            <button class="btn" id="grant-btn" disabled>Dar blíster(s)</button>
          </div>
          <p id="grant-message" style="margin-top: 0.5rem;"></p>
        </div>

        <div style="margin-top: 2rem;">
          <h2>Historial</h2>
          <table style="width: 100%; margin-top: 0.75rem; border-collapse: collapse;">
            <thead>
              <tr>
                <th style="text-align: left; padding: 0.4rem;">Usuario</th>
                <th style="text-align: left; padding: 0.4rem;">Fecha</th>
              </tr>
            </thead>
            <tbody id="history-body"></tbody>
          </table>
        </div>
      </div>
    </div>
    <script type="module" src="/src/admin.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `src/admin.ts`**

```ts
interface AdminUser {
  twitchId: string;
  username: string;
  avatarUrl: string | null;
}

interface HistoryRow {
  id: number;
  userId: string;
  username: string;
  createdAt: string;
}

const BASE = "/api/admin";

type RequestResult<T> = { ok: true; data: T } | { ok: false; status: number };

async function request<T>(path: string, init?: RequestInit): Promise<RequestResult<T>> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: (await res.json()) as T };
}

let selectedUser: AdminUser | null = null;
let searchDebounce: ReturnType<typeof setTimeout> | undefined;

function showLoginView(): void {
  document.getElementById("login-view")!.style.display = "block";
  document.getElementById("panel-view")!.style.display = "none";
}

function showPanelView(): void {
  document.getElementById("login-view")!.style.display = "none";
  document.getElementById("panel-view")!.style.display = "block";
}

function renderHistory(history: HistoryRow[]): void {
  document.getElementById("history-body")!.innerHTML = history
    .map((h) => `<tr><td style="padding: 0.4rem;">${h.username}</td><td style="padding: 0.4rem;">${h.createdAt}</td></tr>`)
    .join("");
}

function renderSearchResults(users: AdminUser[]): void {
  const container = document.getElementById("search-results")!;
  if (users.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = users
    .map((u) => `<span class="badge" data-twitch-id="${u.twitchId}" style="cursor: pointer; margin: 0.2rem;">${u.username}</span>`)
    .join("");
  container.querySelectorAll<HTMLElement>("[data-twitch-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const user = users.find((u) => u.twitchId === el.dataset.twitchId)!;
      selectUser(user);
    });
  });
}

function selectUser(user: AdminUser): void {
  selectedUser = user;
  document.getElementById("selected-user")!.style.display = "flex";
  document.getElementById("selected-user-name")!.textContent = user.username;
  document.getElementById("search-results")!.innerHTML = "";
  (document.getElementById("search-input") as HTMLInputElement).value = "";
  (document.getElementById("grant-btn") as HTMLButtonElement).disabled = false;
}

function clearSelection(): void {
  selectedUser = null;
  document.getElementById("selected-user")!.style.display = "none";
  (document.getElementById("grant-btn") as HTMLButtonElement).disabled = true;
}

async function runSearch(query: string): Promise<void> {
  if (!query) {
    renderSearchResults([]);
    return;
  }
  const result = await request<{ users: AdminUser[] }>(`/users?q=${encodeURIComponent(query)}`);
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  renderSearchResults(result.data.users);
}

function showConfirmModal(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position: fixed; inset: 0; background: rgba(59,46,34,0.80); display: flex; align-items: center; justify-content: center; z-index: 10; padding: 1rem;";
    const box = document.createElement("div");
    box.className = "card";
    box.style.cssText = "max-width: 320px; text-align: center;";
    box.innerHTML = `<p style="margin-bottom: 1rem;">${message}</p>`;

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn";
    confirmBtn.textContent = "Confirmar";
    confirmBtn.style.marginRight = "0.5rem";
    confirmBtn.addEventListener("click", () => {
      overlay.remove();
      resolve(true);
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancelar";
    cancelBtn.addEventListener("click", () => {
      overlay.remove();
      resolve(false);
    });

    box.appendChild(confirmBtn);
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

async function loadHistory(): Promise<void> {
  const result = await request<{ history: HistoryRow[] }>("/history");
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  renderHistory(result.data.history);
}

async function grantPacks(): Promise<void> {
  if (!selectedUser) return;
  const quantity = Number((document.getElementById("quantity-input") as HTMLInputElement).value);
  const messageEl = document.getElementById("grant-message")!;

  const confirmed = await showConfirmModal(`¿Dar ${quantity} blíster(s) a ${selectedUser.username}?`);
  if (!confirmed) return;

  const result = await request<{ ok: true }>("/grant-packs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ twitchId: selectedUser.twitchId, quantity }),
  });

  if (!result.ok) {
    if (result.status === 401) {
      showLoginView();
      return;
    }
    messageEl.textContent = "Error al dar blíster(s).";
    return;
  }

  messageEl.textContent = `Blíster(s) entregado(s) a ${selectedUser.username}.`;
  clearSelection();
  await loadHistory();
}

async function login(): Promise<void> {
  const password = (document.getElementById("login-password") as HTMLInputElement).value;
  const errorEl = document.getElementById("login-error")!;

  const result = await request<{ ok: true }>("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (!result.ok) {
    errorEl.textContent = "Clave incorrecta.";
    errorEl.style.display = "block";
    return;
  }

  errorEl.style.display = "none";
  showPanelView();
  await loadHistory();
}

async function logout(): Promise<void> {
  await request("/logout", { method: "POST" });
  showLoginView();
}

document.getElementById("login-btn")!.addEventListener("click", login);
document.getElementById("logout-btn")!.addEventListener("click", logout);
document.getElementById("clear-selection-btn")!.addEventListener("click", clearSelection);
document.getElementById("grant-btn")!.addEventListener("click", grantPacks);
document.getElementById("search-input")!.addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  const query = (e.target as HTMLInputElement).value;
  searchDebounce = setTimeout(() => runSearch(query), 250);
});

async function init(): Promise<void> {
  const result = await request<{ history: HistoryRow[] }>("/history");
  if (result.ok) {
    showPanelView();
    renderHistory(result.data.history);
  } else {
    showLoginView();
  }
}

init();
```

- [ ] **Step 4: Type-check and build**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors, and `dist/client` contains `admin.html` alongside the other pages.

- [ ] **Step 5: Manual verification**

Run: `npm run dev`, then in a browser:
1. Visit `http://localhost:5173/admin.html` — expect the login view (password field), not the panel.
2. Enter the wrong password — expect "Clave incorrecta." and still on the login view.
3. Enter `test-admin-password` (the value from `.dev.vars`) — expect the panel view with an empty history table.
4. Type a few characters of a username that exists in your local D1 `users` table into the search box — expect a clickable badge to appear after ~250ms.
5. Click the badge — expect it to appear as the selected-user chip, search results to clear, and the "Dar blíster(s)" button to become enabled.
6. Set quantity to `2`, click "Dar blíster(s)" — expect the custom confirm modal (not a native browser dialog), confirm it — expect a success message, the selection to clear, and 2 new rows in the history table for that username.
7. Click "Cerrar sesión" — expect the login view again; reload the page — expect the login view (not the panel), confirming the cookie was cleared.

- [ ] **Step 6: Commit**

```bash
git add admin.html src/admin.ts vite.config.ts
git commit -m "feat: add admin panel UI for granting packs"
```

---

## Deployment Notes

These are one-time production steps, not part of the automated task flow above — run manually when ready to ship, with explicit confirmation since they touch production:

1. Set the production secret (will prompt for the value interactively):
   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```
   Enter `Admin123456789*` when prompted.
2. Deploy as usual (`npm run deploy` or the existing `deploy.bat`).
3. Apply migration `0005_pack_source.sql` to the remote D1 database:
   ```bash
   npx wrangler d1 migrations apply twitch-cards-db --remote
   ```
4. Visit `https://cards.mrklypp.com/admin.html` and repeat the manual verification checklist from Task 4 Step 5 against production, using a real registered username.
