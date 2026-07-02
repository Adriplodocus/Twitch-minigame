# Admin User List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a paginated "all users" list to the existing admin panel (`admin.html`), with a one-click "+1 blíster" button per row, alongside the search-based grant flow already shipped.

**Architecture:** One new read endpoint (`GET /api/admin/users/all?page=`) added to the existing `worker/routes/admin.ts` Hono sub-app, reusing `requireAdmin`. The existing `POST /api/admin/grant-packs` endpoint is reused unchanged for the quick-grant action. Frontend adds a new section to `admin.html` and new rendering/pagination logic to `src/admin.ts`, refactoring the existing single-user grant flow into a shared helper both the search flow and the new list rows call.

**Tech Stack:** Hono, Cloudflare Workers + D1, Vite, Vitest + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- `GET /api/admin/users/all` is a separate endpoint from the existing `GET /api/admin/users?q=` — the search endpoint's behavior and response shape do not change.
- Pagination: `page` is 1-indexed, defaults to `1`. Page size is exactly 20. Response includes `hasMore: boolean` computed by fetching 21 rows and checking for the 21st, not a separate `COUNT(*)` query.
- Users are ordered alphabetically by `username` (`ORDER BY username`).
- The "+1 blíster" button always grants exactly `quantity: 1` — no per-row quantity input.
- No new CSS classes — reuse `.btn`/`.input`/`.badge`/`.card` from `src/style.css`, inline `style="..."` for one-off layout, matching the existing convention in this file/repo.
- Rendering of any DB-sourced string (username, etc.) must use `textContent`/DOM APIs, not `innerHTML` string interpolation — this codebase already standardized on that pattern in `src/admin.ts` (see the existing `renderHistory`/`renderSearchResults`/`showConfirmModal` functions).

---

### Task 1: `GET /api/admin/users/all` endpoint

**Files:**
- Modify: `worker/routes/admin.ts`
- Modify: `test/routes/admin.test.ts`

**Interfaces:**
- Produces: `GET /api/admin/users/all?page=<n>` (requireAdmin) → 200 `{ users: { twitchId: string; username: string; avatarUrl: string | null }[]; page: number; hasMore: boolean }`. Task 2 (frontend) consumes this exact shape.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/admin.test.ts` (after the existing `beforeEach`, anywhere among the other `it(...)` blocks — order doesn't matter since each test is independent):

```ts
it("lists all users alphabetically on page 1 with hasMore false when there are 20 or fewer", async () => {
  const cookie = await adminCookie();
  const res = await app.request("/api/admin/users/all", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ users: { username: string }[]; page: number; hasMore: boolean }>();
  expect(json.page).toBe(1);
  expect(json.hasMore).toBe(false);
  expect(json.users.map((u) => u.username)).toEqual(["viewer1", "viewer2"]);
});

it("paginates the full user list with hasMore true when a 21st user exists", async () => {
  const statements = Array.from({ length: 19 }, (_, i) =>
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind(`extra-${i}`, `zzz-user-${String(i).padStart(2, "0")}`)
  );
  await env.DB.batch(statements);
  // Now 21 users total: viewer1, viewer2, and 19 "zzz-user-*" (alphabetically last).

  const cookie = await adminCookie();
  const page1 = await app.request("/api/admin/users/all?page=1", { headers: { Cookie: cookie } }, env);
  const page1Json = await page1.json<{ users: { username: string }[]; page: number; hasMore: boolean }>();
  expect(page1Json.page).toBe(1);
  expect(page1Json.users).toHaveLength(20);
  expect(page1Json.hasMore).toBe(true);

  const page2 = await app.request("/api/admin/users/all?page=2", { headers: { Cookie: cookie } }, env);
  const page2Json = await page2.json<{ users: { username: string }[]; page: number; hasMore: boolean }>();
  expect(page2Json.page).toBe(2);
  expect(page2Json.users).toHaveLength(1);
  expect(page2Json.hasMore).toBe(false);
});

it("requires an admin session for the full user list", async () => {
  const res = await app.request("/api/admin/users/all", {}, env);
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:worker -- admin`
Expected: FAIL with a 404 (no such route) for the three new tests, since `GET /users/all` doesn't exist yet.

- [ ] **Step 3: Implement the endpoint**

In `worker/routes/admin.ts`, add this route (place it before the existing `admin.get("/users", ...)` route — Hono matches routes in registration order and `/users/all` must not be shadowed by a param-less `/users` handler; since the existing route is registered as the literal path `/users`, not `/users/:something`, there's actually no shadowing risk either way, but placing `/users/all` first keeps the two list-oriented routes grouped together):

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:worker -- admin`
Expected: PASS (all admin tests, including the 3 new ones)

- [ ] **Step 5: Run the full worker test suite to check for regressions**

Run: `npm run test:worker`
Expected: PASS (all files)

- [ ] **Step 6: Commit**

```bash
git add worker/routes/admin.ts test/routes/admin.test.ts
git commit -m "feat: add paginated all-users endpoint to admin panel"
```

---

### Task 2: Frontend user list with pagination and quick-grant

**Files:**
- Modify: `admin.html`
- Modify: `src/admin.ts`

**Interfaces:**
- Consumes: `GET /api/admin/users/all?page=` from Task 1, exact shape `{ users: AdminUser[]; page: number; hasMore: boolean }` (the `AdminUser` interface already exists in `src/admin.ts` — reuse it, don't redefine).
- Consumes: existing `POST /api/admin/grant-packs`, existing `showConfirmModal(quantity: number, username: string): Promise<boolean>`, existing `loadHistory(): Promise<void>`, existing `request<T>()` helper — all already defined in `src/admin.ts`.
- Produces: nothing new for later tasks (this is the last task in this plan).

- [ ] **Step 1: Add the new section to `admin.html`**

In `admin.html`, insert this new section between the existing "Dar blíster" `<div>` (which ends right before the "Historial" `<div>`) and the "Historial" `<div>`:

```html
        <div style="margin-top: 2rem;">
          <h2>Todos los usuarios</h2>
          <table style="width: 100%; margin-top: 0.75rem; border-collapse: collapse;">
            <thead>
              <tr>
                <th style="text-align: left; padding: 0.4rem;">Usuario</th>
                <th style="text-align: left; padding: 0.4rem;"></th>
              </tr>
            </thead>
            <tbody id="all-users-body"></tbody>
          </table>
          <div style="margin-top: 0.75rem; display: flex; gap: 0.5rem;">
            <button class="btn" id="users-prev-btn">Anterior</button>
            <button class="btn" id="users-next-btn">Siguiente</button>
          </div>
        </div>
```

So the full `panel-view` div's children end up in this order: logout/back-link row, "Dar blíster" div, this new "Todos los usuarios" div, "Historial" div.

- [ ] **Step 2: Refactor the existing grant flow into a shared helper**

In `src/admin.ts`, replace the existing `grantPacks` function:

```ts
async function grantPacks(): Promise<void> {
  if (!selectedUser) return;
  const quantity = Number((document.getElementById("quantity-input") as HTMLInputElement).value);
  const messageEl = document.getElementById("grant-message")!;

  const confirmed = await showConfirmModal(quantity, selectedUser.username);
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
```

with this shared helper plus a thin wrapper for the search flow's button:

```ts
async function performGrant(twitchId: string, quantity: number, username: string): Promise<void> {
  const messageEl = document.getElementById("grant-message")!;

  const confirmed = await showConfirmModal(quantity, username);
  if (!confirmed) return;

  const result = await request<{ ok: true }>("/grant-packs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ twitchId, quantity }),
  });

  if (!result.ok) {
    if (result.status === 401) {
      showLoginView();
      return;
    }
    messageEl.textContent = "Error al dar blíster(s).";
    return;
  }

  messageEl.textContent = `Blíster(s) entregado(s) a ${username}.`;
  await loadHistory();
}

async function grantPacks(): Promise<void> {
  if (!selectedUser) return;
  const quantity = Number((document.getElementById("quantity-input") as HTMLInputElement).value);
  await performGrant(selectedUser.twitchId, quantity, selectedUser.username);
  clearSelection();
}
```

Note `performGrant` no longer calls `clearSelection()` itself (that was specific to the search flow's selected-user state, which the new list rows don't have) — `grantPacks()` calls it after `performGrant` resolves, preserving the exact previous behavior for the search flow.

- [ ] **Step 3: Add pagination state, rendering, and event wiring**

In `src/admin.ts`, add this near the other module-level state (next to `let selectedUser` / `let searchDebounce`):

```ts
let currentUsersPage = 1;
```

Add this new function (place it near `renderHistory`/`renderSearchResults`, following the same DOM-building convention — no `innerHTML`):

```ts
function renderAllUsers(users: AdminUser[]): void {
  const container = document.getElementById("all-users-body")!;
  const rows = users.map((u) => {
    const tr = document.createElement("tr");

    const tdUsername = document.createElement("td");
    tdUsername.style.padding = "0.4rem";
    tdUsername.textContent = u.username;

    const tdAction = document.createElement("td");
    tdAction.style.padding = "0.4rem";
    const grantBtn = document.createElement("button");
    grantBtn.className = "btn";
    grantBtn.textContent = "+1 blíster";
    grantBtn.addEventListener("click", () => performGrant(u.twitchId, 1, u.username));
    tdAction.appendChild(grantBtn);

    tr.appendChild(tdUsername);
    tr.appendChild(tdAction);
    return tr;
  });
  container.replaceChildren(...rows);
}

async function loadAllUsers(page: number): Promise<void> {
  const result = await request<{ users: AdminUser[]; page: number; hasMore: boolean }>(`/users/all?page=${page}`);
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  currentUsersPage = result.data.page;
  renderAllUsers(result.data.users);
  (document.getElementById("users-prev-btn") as HTMLButtonElement).disabled = currentUsersPage <= 1;
  (document.getElementById("users-next-btn") as HTMLButtonElement).disabled = !result.data.hasMore;
}
```

Add these event listeners next to the existing `document.getElementById("login-btn")!.addEventListener(...)` block:

```ts
document.getElementById("users-prev-btn")!.addEventListener("click", () => {
  if (currentUsersPage > 1) loadAllUsers(currentUsersPage - 1);
});
document.getElementById("users-next-btn")!.addEventListener("click", () => {
  loadAllUsers(currentUsersPage + 1);
});
```

Finally, update `init()` and `login()` to also load the first page of the users list alongside history. Replace:

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

with:

```ts
async function init(): Promise<void> {
  const result = await request<{ history: HistoryRow[] }>("/history");
  if (result.ok) {
    showPanelView();
    renderHistory(result.data.history);
    await loadAllUsers(1);
  } else {
    showLoginView();
  }
}
```

And in `login()`, replace:

```ts
  errorEl.style.display = "none";
  showPanelView();
  await loadHistory();
}
```

with:

```ts
  errorEl.style.display = "none";
  showPanelView();
  await loadHistory();
  await loadAllUsers(1);
}
```

- [ ] **Step 4: Build to verify no TypeScript errors**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors, `dist/client/admin.html` still produced.

- [ ] **Step 5: Manual verification**

Run: `npm run dev`, then in a browser at `http://localhost:5173/admin.html`:
1. Log in — expect the new "Todos los usuarios" table to appear below "Dar blíster", populated with users ordered alphabetically, each row showing a "+1 blíster" button.
2. If you have 20 or fewer local users, "Siguiente" should be disabled; "Anterior" should always start disabled on page 1.
3. Click "+1 blíster" on a row — expect the same custom confirm modal as the search flow ("¿Dar 1 blíster(s) a `<username>`?"), confirm it, and expect a success message plus a new row in the history table below.
4. Confirm the existing search-and-select flow (search box, quantity input, "Dar blíster(s)" button) still works exactly as before — this task must not change its behavior.

- [ ] **Step 6: Commit**

```bash
git add admin.html src/admin.ts
git commit -m "feat: add paginated user list with quick-grant to admin panel"
```

---

## Deployment Notes

No new migration, no new secret — this plan only adds a route and frontend code on top of the already-deployed admin panel infrastructure (schema, secret, and session handling from the prior `admin-grant-packs` plan are already in production). Standard `git push` + `npm run deploy` covers it.
