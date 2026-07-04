# Admin Panel Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the admin panel: history shows source + tier + admin attribution for all pack sources (25 rows), the "Todos los usuarios" list is removed in favor of direct search, the "Dar blíster" heading is removed, and the header matches the `page-header` pattern used elsewhere.

**Architecture:** Admin sessions gain a free-text `adminName` (entered at login, carried in the JWT) so grant-packs can attribute who granted a pack. A new nullable `granted_by` column on `packs` stores that name. The history endpoint drops its `source = 'admin'` filter and returns all sources with attribution; the frontend formats admin-sourced rows as `"{grantedBy} -> {username}"`. The user-list-all feature (list + pagination) is deleted outright; direct search already covers user selection.

**Tech Stack:** Hono (Cloudflare Workers backend), `jose` for JWT, D1 (SQLite) via Wrangler migrations, Vitest (`test/routes/admin.test.ts`, `cloudflare:test` pool), vanilla TypeScript/DOM frontend (`src/admin.ts`), no framework.

## Global Constraints

- No change to `tier` values (`gratis`/`apoyo`) or to the grant-packs quantity/tier inputs beyond removing the "Dar blíster" heading.
- No change to the direct-search flow (`GET /users?q=`) — it remains the only way to pick a user.
- `granted_by` is nullable; only ever populated for `source = 'admin'` rows. `reward` rows leave it `NULL`.
- History returns at most 25 rows, most recent first, across all sources (no `WHERE source = ...` filter).
- Admin login requires a non-empty `name` (trimmed) in addition to the password; validate name before password (400 `{ error: "Name required" }` if missing, then 401 `{ error: "Invalid password" }` if the password is wrong).
- No `#user-avatar`/`#user-name` in admin.html's header — the admin session has no Twitch identity, so `initUserHeader()` is not used there. The existing `logout()` function in `src/admin.ts` (calls `POST /api/admin/logout`) stays wired to `#logout-btn`; only surrounding markup changes.

---

### Task 1: Admin identity — login requires a name, JWT carries it

**Files:**
- Modify: `worker/lib/jwt.ts:28-43` (`signAdminSession`, `verifyAdminSession`)
- Modify: `worker/middleware/auth.ts:18-24` (`requireAdmin`)
- Modify: `worker/routes/admin.ts:9-23` (`POST /login`)
- Test: `test/routes/admin.test.ts` (login tests + `adminCookie` helper)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `signAdminSession(secret: string, adminName: string): Promise<string>`; `verifyAdminSession(token: string, secret: string): Promise<{ adminName: string } | null>`; `requireAdmin` middleware sets Hono context variable `adminName: string` (via `c.set("adminName", ...)`, `c.get("adminName")` in downstream handlers). Task 2 consumes `c.get("adminName")` in the grant-packs handler.

- [ ] **Step 1: Write failing tests for the new login/session behavior**

Replace the `adminCookie` helper and the two login tests near the top of `test/routes/admin.test.ts`:

```ts
async function adminCookie(adminName = "Test Admin"): Promise<string> {
  const token = await signAdminSession(env.JWT_SECRET, adminName);
  return `admin_session=${token}`;
}
```

Replace:

```ts
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
```

with:

```ts
it("rejects login with a missing name", async () => {
  const res = await app.request(
    "/api/admin/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects login with a blank name", async () => {
  const res = await app.request(
    "/api/admin/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD, name: "   " }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects login with the wrong password", async () => {
  const res = await app.request(
    "/api/admin/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong", name: "Test Admin" }),
    },
    env
  );
  expect(res.status).toBe(401);
});

it("accepts login with the correct password and name, and sets a cookie", async () => {
  const res = await app.request(
    "/api/admin/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD, name: "Test Admin" }),
    },
    env
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("admin_session=");
});
```

Every other existing call to `adminCookie()` in the file stays as-is (it now defaults `adminName` to `"Test Admin"`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:worker -- admin.test.ts`
Expected: FAIL — `signAdminSession` still takes one argument, login route doesn't validate `name`, new tests fail (missing-name/blank-name expect 400 but route returns 200/401).

- [ ] **Step 3: Update `worker/lib/jwt.ts`**

Replace:

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

with:

```ts
export async function signAdminSession(secret: string, adminName: string): Promise<string> {
  return new SignJWT({ role: "admin", adminName })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getKey(secret));
}

export async function verifyAdminSession(token: string, secret: string): Promise<{ adminName: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getKey(secret));
    if (payload.role !== "admin") return null;
    const adminName = typeof payload.adminName === "string" ? payload.adminName : "Admin";
    return { adminName };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Update `worker/middleware/auth.ts`**

Replace:

```ts
export const requireAdmin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = getCookie(c, "admin_session");
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const valid = await verifyAdminSession(token, c.env.JWT_SECRET);
  if (!valid) return c.json({ error: "Unauthorized" }, 401);
  await next();
});
```

with:

```ts
export const requireAdmin = createMiddleware<{
  Bindings: Env;
  Variables: { adminName: string };
}>(async (c, next) => {
  const token = getCookie(c, "admin_session");
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const session = await verifyAdminSession(token, c.env.JWT_SECRET);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  c.set("adminName", session.adminName);
  await next();
});
```

- [ ] **Step 5: Update `POST /login` in `worker/routes/admin.ts`**

Replace:

```ts
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
```

with:

```ts
admin.post("/login", async (c) => {
  const body = await c.req
    .json<{ password?: string; name?: string }>()
    .catch(() => ({}) as { password?: string; name?: string });
  const name = body.name?.trim();
  if (!name) {
    return c.json({ error: "Name required" }, 400);
  }
  if (!body.password || body.password !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "Invalid password" }, 401);
  }
  const token = await signAdminSession(c.env.JWT_SECRET, name);
  setCookie(c, "admin_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.json({ ok: true });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:worker -- admin.test.ts`
Expected: PASS (all tests in the file, including the ones not touched by this task — they use the now-two-argument `adminCookie()` default).

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add worker/lib/jwt.ts worker/middleware/auth.ts worker/routes/admin.ts test/routes/admin.test.ts
git commit -m "feat: require admin name at login, carry it in session"
```

---

### Task 2: History shows all sources + attribution; remove full user list

**Files:**
- Create: `migrations/0011_pack_granted_by.sql`
- Modify: `worker/routes/admin.ts` (`POST /grant-packs`, `GET /history`; delete `GET /users/all`)
- Test: `test/routes/admin.test.ts` (grant-packs/history tests; delete `/users/all` tests)

**Interfaces:**
- Consumes: `c.get("adminName")` from Task 1's `requireAdmin` middleware (already applied to these routes via `admin.post("/grant-packs", requireAdmin, ...)` / `admin.get("/history", requireAdmin, ...)`).
- Produces: `GET /history` response shape `{ history: { id: number; userId: string; username: string; tier: string; source: string; grantedBy: string | null; createdAt: string }[] }`. Task 3 (frontend) consumes this exact shape.

- [ ] **Step 1: Write the migration**

Create `migrations/0011_pack_granted_by.sql`:

```sql
ALTER TABLE packs ADD COLUMN granted_by TEXT;
```

- [ ] **Step 2: Write failing tests**

Replace the existing `/users/all` tests (the two tests starting `"lists all users alphabetically..."` and `"paginates the full user list..."`, plus `"requires an admin session for the full user list"`) — delete all three, they test a route this task removes.

Replace the existing grant/history test:

```ts
it("grants packs with the chosen tier and lists them in history", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 3, tier: "apoyo" }),
    },
    env
  );
  expect(res.status).toBe(200);

  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("1")
    .all<{ source: string; tier: string }>();
  expect(packs.results).toHaveLength(3);
  expect(packs.results.every((p) => p.source === "admin" && p.tier === "apoyo")).toBe(true);

  const historyRes = await app.request("/api/admin/history", { headers: { Cookie: cookie } }, env);
  const historyJson = await historyRes.json<{ history: { username: string; tier: string }[] }>();
  expect(historyJson.history).toHaveLength(3);
  expect(historyJson.history[0].username).toBe("viewer1");
  expect(historyJson.history[0].tier).toBe("apoyo");
});
```

with:

```ts
it("grants packs with the chosen tier, records who granted them, and lists them in history", async () => {
  const cookie = await adminCookie("Grantor Name");
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 3, tier: "apoyo" }),
    },
    env
  );
  expect(res.status).toBe(200);

  const packs = await env.DB.prepare("SELECT source, tier, granted_by AS grantedBy FROM packs WHERE user_id = ?")
    .bind("1")
    .all<{ source: string; tier: string; grantedBy: string | null }>();
  expect(packs.results).toHaveLength(3);
  expect(packs.results.every((p) => p.source === "admin" && p.tier === "apoyo" && p.grantedBy === "Grantor Name")).toBe(
    true
  );

  const historyRes = await app.request("/api/admin/history", { headers: { Cookie: cookie } }, env);
  const { history } = await historyRes.json<{
    history: { username: string; tier: string; source: string; grantedBy: string | null }[];
  }>();
  expect(history).toHaveLength(3);
  expect(history[0].username).toBe("viewer1");
  expect(history[0].tier).toBe("apoyo");
  expect(history[0].source).toBe("admin");
  expect(history[0].grantedBy).toBe("Grantor Name");
});

it("includes non-admin (reward) sourced packs in history with a null grantedBy", async () => {
  await env.DB.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, 'reward', 'gratis')").bind("2").run();
  const cookie = await adminCookie();
  const historyRes = await app.request("/api/admin/history", { headers: { Cookie: cookie } }, env);
  const { history } = await historyRes.json<{
    history: { username: string; source: string; grantedBy: string | null }[];
  }>();
  const rewardRow = history.find((h) => h.username === "viewer2");
  expect(rewardRow).toBeDefined();
  expect(rewardRow!.source).toBe("reward");
  expect(rewardRow!.grantedBy).toBeNull();
});

it("caps history at 25 rows", async () => {
  const statements = Array.from({ length: 30 }, () =>
    env.DB.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, 'reward', 'gratis')").bind("1")
  );
  await env.DB.batch(statements);
  const cookie = await adminCookie();
  const historyRes = await app.request("/api/admin/history", { headers: { Cookie: cookie } }, env);
  const { history } = await historyRes.json<{ history: unknown[] }>();
  expect(history).toHaveLength(25);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:worker -- admin.test.ts`
Expected: FAIL — `granted_by` column doesn't exist yet, `/history` still filters to `source = 'admin'` and doesn't return `source`/`grantedBy`, `/users/all` tests fail because the route still exists but the test file no longer matches deleted-route expectations (these three tests should simply be absent after Step 2, so this failure is specifically about the two grant/history tests and the new reward/cap tests).

- [ ] **Step 4: Apply the migration to the test DB**

Run: `npm run test:worker -- admin.test.ts` again after confirming migrations auto-apply via `test/apply-migrations.ts` (`applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` runs every migration file, including the new one, automatically — no manual step needed beyond having created the file in Step 1).

- [ ] **Step 5: Update `POST /grant-packs` in `worker/routes/admin.ts`**

Replace:

```ts
  const statements = Array.from({ length: quantity }, () =>
    c.env.DB.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, 'admin', ?)").bind(twitchId, tier)
  );
  await c.env.DB.batch(statements);
```

with:

```ts
  const adminName = c.get("adminName");
  const statements = Array.from({ length: quantity }, () =>
    c.env.DB.prepare("INSERT INTO packs (user_id, source, tier, granted_by) VALUES (?, 'admin', ?, ?)").bind(
      twitchId,
      tier,
      adminName
    )
  );
  await c.env.DB.batch(statements);
```

- [ ] **Step 6: Update `GET /history` in `worker/routes/admin.ts`**

Replace:

```ts
admin.get("/history", requireAdmin, async (c) => {
  const history = await c.env.DB.prepare(
    `SELECT p.id, p.user_id AS userId, u.username, p.tier AS tier, p.created_at AS createdAt
     FROM packs p JOIN users u ON u.twitch_id = p.user_id
     WHERE p.source = 'admin'
     ORDER BY p.created_at DESC LIMIT 20`
  ).all<{ id: number; userId: string; username: string; tier: string; createdAt: string }>();
  return c.json({ history: history.results });
});
```

with:

```ts
admin.get("/history", requireAdmin, async (c) => {
  const history = await c.env.DB.prepare(
    `SELECT p.id, p.user_id AS userId, u.username, p.tier AS tier, p.source AS source,
            p.granted_by AS grantedBy, p.created_at AS createdAt
     FROM packs p JOIN users u ON u.twitch_id = p.user_id
     ORDER BY p.created_at DESC LIMIT 25`
  ).all<{
    id: number;
    userId: string;
    username: string;
    tier: string;
    source: string;
    grantedBy: string | null;
    createdAt: string;
  }>();
  return c.json({ history: history.results });
});
```

- [ ] **Step 7: Delete `GET /users/all`**

Remove this entire route from `worker/routes/admin.ts`:

```ts
admin.get("/users/all", requireAdmin, async (c) => {
  const pageParam = Number(c.req.query("page"));
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
  const offset = (page - 1) * 20;

  const result = await c.env.DB.prepare(
    `SELECT twitch_id AS twitchId, username, avatar_url AS avatarUrl
     FROM users ORDER BY username LIMIT 21 OFFSET ?`
  )
    .bind(offset)
    .all<{ twitchId: string; username: string; avatarUrl: string | null }>();

  const hasMore = result.results.length > 20;
  const users = result.results.slice(0, 20);

  return c.json({ users, page, hasMore });
});
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm run test:worker -- admin.test.ts`
Expected: PASS.

- [ ] **Step 9: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add migrations/0011_pack_granted_by.sql worker/routes/admin.ts test/routes/admin.test.ts
git commit -m "feat: show all pack sources in admin history, remove full user list"
```

---

### Task 3: Frontend — history rendering, header parity, remove dead UI

**Files:**
- Modify: `admin.html`
- Modify: `src/admin.ts`

**Interfaces:**
- Consumes: `GET /api/admin/history` response `{ history: { id: number; userId: string; username: string; tier: string; source: string; grantedBy: string | null; createdAt: string }[] }` (Task 2). `POST /api/admin/login` now requires `{ password: string; name: string }` (Task 1).
- Produces: nothing consumed by other tasks (this is the last task).

There is no unit-test harness for `src/*.ts` frontend files in this repo (only `test/routes/*.ts` backend tests exist). Verification for this task is `npx tsc --noEmit` plus a manual browser check — no automated test steps.

- [ ] **Step 1: Update `admin.html`**

Replace the entire `<body>` content with:

```html
  <body>
    <header class="page-header">
      <div class="page-header-actions">
        <a class="btn btn-icon" href="/collection.html">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          Volver a Colección
        </a>
      </div>
      <div class="page-header-user">
        <button class="icon-btn" id="logout-btn" type="button" title="Cerrar sesión" aria-label="Cerrar sesión">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>
    </header>
    <div class="container" style="padding: 2rem 1rem;">
      <h1>Admin</h1>

      <div id="login-view" style="margin-top: 1.5rem; max-width: 320px;">
        <input class="input" id="login-name" type="text" placeholder="Nombre" style="width: 100%;" />
        <input class="input" id="login-password" type="password" placeholder="Clave" style="width: 100%; margin-top: 0.5rem;" />
        <button class="btn" id="login-btn" style="margin-top: 0.75rem;">Entrar</button>
        <p id="login-error" style="color: #C2477F; margin-top: 0.5rem; display: none;"></p>
      </div>

      <div id="panel-view" style="display: none; margin-top: 1.5rem;">
        <div>
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
            <select class="input" id="tier-select">
              <option value="gratis">Gratis</option>
              <option value="apoyo">Apoyo</option>
            </select>
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
                <th style="text-align: left; padding: 0.4rem;">Tier</th>
                <th style="text-align: left; padding: 0.4rem;">Fuente</th>
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
```

(Keep the existing `<head>` unchanged — only `<body>` changes.)

- [ ] **Step 2: Update `HistoryRow` type and `renderHistory` in `src/admin.ts`**

Replace:

```ts
interface HistoryRow {
  id: number;
  userId: string;
  username: string;
  tier: string;
  createdAt: string;
}
```

with:

```ts
interface HistoryRow {
  id: number;
  userId: string;
  username: string;
  tier: string;
  source: string;
  grantedBy: string | null;
  createdAt: string;
}
```

Replace:

```ts
function renderHistory(history: HistoryRow[]): void {
  const container = document.getElementById("history-body")!;
  const rows = history.map((h) => {
    const tr = document.createElement("tr");
    const tdUsername = document.createElement("td");
    tdUsername.style.padding = "0.4rem";
    tdUsername.textContent = h.username;
    const tdTier = document.createElement("td");
    tdTier.style.padding = "0.4rem";
    tdTier.textContent = h.tier;
    const tdCreatedAt = document.createElement("td");
    tdCreatedAt.style.padding = "0.4rem";
    tdCreatedAt.textContent = h.createdAt;
    tr.appendChild(tdUsername);
    tr.appendChild(tdTier);
    tr.appendChild(tdCreatedAt);
    return tr;
  });
  container.replaceChildren(...rows);
}
```

with:

```ts
function renderHistory(history: HistoryRow[]): void {
  const container = document.getElementById("history-body")!;
  const rows = history.map((h) => {
    const tr = document.createElement("tr");
    const tdUsername = document.createElement("td");
    tdUsername.style.padding = "0.4rem";
    tdUsername.textContent = h.source === "admin" ? `${h.grantedBy ?? "Admin"} -> ${h.username}` : h.username;
    const tdTier = document.createElement("td");
    tdTier.style.padding = "0.4rem";
    tdTier.textContent = h.tier;
    const tdSource = document.createElement("td");
    tdSource.style.padding = "0.4rem";
    tdSource.textContent = h.source;
    const tdCreatedAt = document.createElement("td");
    tdCreatedAt.style.padding = "0.4rem";
    tdCreatedAt.textContent = h.createdAt;
    tr.appendChild(tdUsername);
    tr.appendChild(tdTier);
    tr.appendChild(tdSource);
    tr.appendChild(tdCreatedAt);
    return tr;
  });
  container.replaceChildren(...rows);
}
```

- [ ] **Step 3: Update `login()` to send the name**

Replace:

```ts
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
  await loadAllUsers(1);
}
```

with:

```ts
async function login(): Promise<void> {
  const name = (document.getElementById("login-name") as HTMLInputElement).value;
  const password = (document.getElementById("login-password") as HTMLInputElement).value;
  const errorEl = document.getElementById("login-error")!;

  const result = await request<{ ok: true }>("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, name }),
  });

  if (!result.ok) {
    errorEl.textContent = result.status === 400 ? "Falta el nombre." : "Clave incorrecta.";
    errorEl.style.display = "block";
    return;
  }

  errorEl.style.display = "none";
  showPanelView();
  await loadHistory();
}
```

- [ ] **Step 4: Remove the "Todos los usuarios" list code**

Delete these from `src/admin.ts`:
- The `currentUsersPage` variable declaration (`let currentUsersPage = 1;`).
- The `renderAllUsers` function (entire function, from `function renderAllUsers(users: AdminUser[]): void {` through its closing `}`).
- The `loadAllUsers` function (entire function, from `async function loadAllUsers(page: number): Promise<void> {` through its closing `}`).
- The `users-prev-btn` and `users-next-btn` event listener registrations (both `document.getElementById("users-prev-btn")!.addEventListener(...)` and `document.getElementById("users-next-btn")!.addEventListener(...)` blocks).
- The `await loadAllUsers(1);` call inside `init()`.

After these deletions, `init()` should read:

```ts
async function init(): Promise<void> {
  const result = await request<{ history: HistoryRow[] }>("/history");
  if (result.ok) {
    showPanelView();
    renderHistory(result.data.history);
  } else {
    showLoginView();
  }
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (no dangling references to deleted functions/variables/DOM ids).

- [ ] **Step 6: Manual verification in browser**

Run: `npm run dev`, open `/admin.html`.

Verify:
- Header shows the back-arrow "Volver a Colección" button and a circular logout icon button, visually matching `collection.html`'s header (no avatar/username shown).
- Login form has a "Nombre" field above "Clave"; submitting with password but no name shows "Falta el nombre."; submitting with wrong password (name filled) shows "Clave incorrecta."
- After logging in, there is no "Todos los usuarios" section anywhere on the page.
- There is no "Dar blíster" heading; the search/quantity/tier/button block still works to grant a pack.
- Granting a pack refreshes "Historial", which now has 4 columns (Usuario, Tier, Fuente, Fecha); the granted row's Usuario column reads `"{the name you logged in with} -> {receiver username}"` and Fuente reads `admin`.
- No console errors.

- [ ] **Step 7: Commit**

```bash
git add admin.html src/admin.ts
git commit -m "feat: rework admin panel UI (history, header, remove dead sections)"
```
