# Sobre Diario Gratis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each logged-in viewer claim one free pack per UTC day from a header button, with a DB-enforced guarantee that concurrent requests (multi-tab, double-click, direct API calls) can never produce more than one claim per user per day.

**Architecture:** A dedicated `daily_pack_claims` table with `PRIMARY KEY (user_id, claim_date)` is the sole source of truth for "did this user already claim today" — the claim endpoint always attempts the INSERT first and reads the PK-violation failure as "already claimed," so there is never a read-then-write race window. A new `worker/routes/daily-pack.ts` Hono route group exposes status/claim over `/api/daily-pack`. The frontend adds a header button (all 4 viewer pages) wired through `user-header.ts`, reusing the existing pending-packs/open-pack flow for the granted pack itself.

**Tech Stack:** Hono + D1 (SQLite) on Cloudflare Workers, vanilla TypeScript frontend, Vitest (`vitest.workers.config.ts` for D1/Worker tests, `vitest.config.ts` for plain-Node/DOM-string tests).

## Global Constraints

- `claim_date` is always computed server-side via SQL `date('now')` (UTC) — never accept a date from the client.
- The "already claimed" path (PK violation) and the natural "just claimed successfully" path must look the same to the frontend user — no error-toast for losing a race.
- Follow existing migration pattern: SQLite `CHECK` constraints can't be altered in place, so adding `'daily'` to `packs.source` requires a full table rebuild (mirrors `migrations/0013_expand_pack_source.sql`).
- New route file follows existing per-feature route-group convention (`worker/routes/*.ts`, mounted in `worker/index.ts`, `requireAuth` from `worker/middleware/auth.ts`).

---

## Task 1: Migrations — `daily` pack source + claims table

**Files:**
- Create: `migrations/0017_daily_pack_source.sql`
- Create: `migrations/0018_daily_pack_claims.sql`

**Interfaces:**
- Produces: `packs.source` CHECK now allows `'daily'`. New table `daily_pack_claims(user_id TEXT, claim_date TEXT, created_at TEXT, PRIMARY KEY(user_id, claim_date))`.

- [ ] **Step 1: Write `migrations/0017_daily_pack_source.sql`**

```sql
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE packs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  opened_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'reward' CHECK (source IN ('reward', 'admin', 'bits', 'sub', 'gift_sub', 'paypal', 'paypal_manual', 'daily')),
  tier TEXT NOT NULL DEFAULT 'gratis' CHECK (tier IN ('gratis', 'apoyo')),
  broadcast_at TEXT,
  granted_by TEXT,
  is_test INTEGER NOT NULL DEFAULT 0
);

INSERT INTO packs_new (id, user_id, opened_at, created_at, source, tier, broadcast_at, granted_by, is_test)
SELECT id, user_id, opened_at, created_at, source, tier, broadcast_at, granted_by, is_test FROM packs;

DROP TABLE packs;
ALTER TABLE packs_new RENAME TO packs;

CREATE INDEX idx_packs_user ON packs(user_id);
```

- [ ] **Step 2: Write `migrations/0018_daily_pack_claims.sql`**

```sql
CREATE TABLE daily_pack_claims (
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  claim_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, claim_date)
);
```

- [ ] **Step 3: Apply migrations locally and verify schema**

Run: `npx wrangler d1 migrations apply twitch-cards-db --local`
Expected: output lists `0017_daily_pack_source.sql` and `0018_daily_pack_claims.sql` as applied, no errors.

Run: `npx wrangler d1 execute twitch-cards-db --local --command "SELECT sql FROM sqlite_master WHERE name IN ('packs','daily_pack_claims')"`
Expected: `packs` CHECK clause includes `'daily'`; `daily_pack_claims` table definition shown with the composite primary key.

- [ ] **Step 4: Commit**

```bash
git add migrations/0017_daily_pack_source.sql migrations/0018_daily_pack_claims.sql
git commit -m "feat: add daily pack source and claims table"
```

---

## Task 2: Backend route — `/api/daily-pack`

**Files:**
- Create: `worker/routes/daily-pack.ts`
- Modify: `worker/index.ts` (mount the route group)
- Test: `test/routes/daily-pack.test.ts`

**Interfaces:**
- Consumes: `requireAuth` middleware from `worker/middleware/auth.ts` (sets `c.get("user")` as `{ twitchId: string; username: string }`), `Env` from `worker/types.ts`, `signSession` from `worker/lib/jwt.ts` (test only).
- Produces: `GET /api/daily-pack/status` → `200 { claimed: boolean }`. `POST /api/daily-pack/claim` → `200 { ok: true }` on success, `409 { error: string }` if already claimed today.

- [ ] **Step 1: Write the failing tests**

Create `test/routes/daily-pack.test.ts`:

```ts
// test/routes/daily-pack.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM daily_pack_claims");
  await env.DB.exec("DELETE FROM pack_cards");
  await env.DB.exec("DELETE FROM user_cards");
  await env.DB.exec("DELETE FROM packs");
  await env.DB.exec("DELETE FROM users");

  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();
});

it("requires auth", async () => {
  const res = await app.request("/api/daily-pack/status", {}, env);
  expect(res.status).toBe(401);
});

it("reports not claimed before any claim", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/daily-pack/status", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ claimed: false });
});

it("claims a daily pack and creates a pending pack", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const pack = await env.DB.prepare("SELECT source, tier, opened_at FROM packs WHERE user_id = ?")
    .bind("1")
    .first<{ source: string; tier: string; opened_at: string | null }>();
  expect(pack?.source).toBe("daily");
  expect(pack?.tier).toBe("gratis");
  expect(pack?.opened_at).toBeNull();

  const statusRes = await app.request("/api/daily-pack/status", { headers: { Cookie: cookie } }, env);
  expect(await statusRes.json()).toEqual({ claimed: true });
});

it("rejects a second claim the same day", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);

  const res = await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(409);

  const packs = await env.DB.prepare("SELECT id FROM packs WHERE user_id = ? AND source = 'daily'").bind("1").all();
  expect(packs.results).toHaveLength(1);
});

it("allows only one winner out of concurrent claims", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const [resA, resB] = await Promise.all([
    app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env),
    app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env),
  ]);
  const statuses = [resA.status, resB.status].sort();
  expect(statuses).toEqual([200, 409]);

  const packs = await env.DB.prepare("SELECT id FROM packs WHERE user_id = ? AND source = 'daily'").bind("1").all();
  expect(packs.results).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:worker -- daily-pack`
Expected: FAIL — `Cannot find module '../../worker/routes/daily-pack'` or 404s, since the route doesn't exist yet.

- [ ] **Step 3: Write `worker/routes/daily-pack.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "../types";
import { requireAuth } from "../middleware/auth";

const dailyPack = new Hono<{ Bindings: Env; Variables: { user: { twitchId: string; username: string } } }>();

dailyPack.get("/status", requireAuth, async (c) => {
  const user = c.get("user");
  const claim = await c.env.DB.prepare(
    "SELECT 1 FROM daily_pack_claims WHERE user_id = ? AND claim_date = date('now')"
  )
    .bind(user.twitchId)
    .first();
  return c.json({ claimed: claim !== null });
});

dailyPack.post("/claim", requireAuth, async (c) => {
  const user = c.get("user");

  try {
    await c.env.DB.prepare("INSERT INTO daily_pack_claims (user_id, claim_date) VALUES (?, date('now'))")
      .bind(user.twitchId)
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      return c.json({ error: "Ya reclamado hoy" }, 409);
    }
    throw err;
  }

  await c.env.DB.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, 'daily', 'gratis')")
    .bind(user.twitchId)
    .run();

  return c.json({ ok: true });
});

export default dailyPack;
```

- [ ] **Step 4: Mount the route in `worker/index.ts`**

In `worker/index.ts`, add the import alongside the other route imports:

```ts
import dailyPack from "./routes/daily-pack";
```

And add the mount line alongside the other `app.route(...)` calls:

```ts
app.route("/api/daily-pack", dailyPack);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:worker -- daily-pack`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add worker/routes/daily-pack.ts worker/index.ts test/routes/daily-pack.test.ts
git commit -m "feat: add daily pack claim endpoint"
```

---

## Task 3: Frontend — header button on the 4 viewer pages

**Files:**
- Modify: `src/api.ts` (add `getDailyPackStatus`, `claimDailyPack`)
- Modify: `src/user-header.ts` (wire button state + click handler)
- Modify: `collection.html`, `trade.html`, `offers.html`, `album.html` (add button markup)
- Modify: `src/style.css` (add `.btn-daily-pack` rules)
- Test: `src/daily-pack-button.test.ts`

**Interfaces:**
- Consumes: `request<T>` helper in `src/api.ts` (existing, unexported, used internally by other `api.ts` functions).
- Produces: `getDailyPackStatus(): Promise<{ claimed: boolean }>`, `claimDailyPack(): Promise<{ ok: true }>` (rejects with `Error("Request failed: 409")` on `request`'s existing non-2xx handling — the caller in `user-header.ts` catches this).

- [ ] **Step 1: Write the failing frontend test**

Create `src/daily-pack-button.test.ts` (mirrors the string-match style of `src/how-to-get-packs.test.ts`):

```ts
// src/daily-pack-button.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("daily pack button", () => {
  it.each(["collection.html", "trade.html", "offers.html", "album.html"])("is present in %s", (file) => {
    const html = readFileSync(resolve(__dirname, "..", file), "utf-8");
    expect(html).toContain('id="daily-pack-btn"');
  });

  it("is absent from admin.html", () => {
    const html = readFileSync(resolve(__dirname, "..", "admin.html"), "utf-8");
    expect(html).not.toContain("daily-pack-btn");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- daily-pack-button`
Expected: FAIL — `id="daily-pack-btn"` not found in any of the 4 HTML files.

- [ ] **Step 3: Add the button markup to the 4 viewer pages**

In each of `collection.html`, `trade.html`, `offers.html`, `album.html`, inside `<div class="page-header-actions">`, add as the **first** child (before the existing `Álbum` link etc.):

```html
<button class="btn btn-daily-pack" id="daily-pack-btn" type="button">🎁 Reclama tu sobre diario</button>
```

(Each page's `page-header-actions` block currently starts differently — e.g. `collection.html` starts with the "Álbum" link. Insert the new button as the first element inside that same `<div class="page-header-actions">` wrapper in every file, keeping the rest of that page's existing links/buttons unchanged after it.)

- [ ] **Step 4: Add API functions to `src/api.ts`**

Add near the bottom of `src/api.ts`, after `getPendingOfferCount`:

```ts
export function getDailyPackStatus(): Promise<{ claimed: boolean }> {
  return request("/daily-pack/status");
}

export function claimDailyPack(): Promise<{ ok: true }> {
  return request("/daily-pack/claim", { method: "POST" });
}
```

- [ ] **Step 5: Wire button behavior in `src/user-header.ts`**

Add the import at the top:

```ts
import { getMe, getPendingOfferCount, getDailyPackStatus, claimDailyPack, logout } from "./api";
```

Add this block inside `initUserHeader()` (after the `howToBtn`/`howToPanel` block is fine):

```ts
  const dailyPackBtn = document.getElementById("daily-pack-btn") as HTMLButtonElement | null;
  if (dailyPackBtn) {
    const markClaimed = () => {
      dailyPackBtn.disabled = true;
      dailyPackBtn.textContent = "✅ Sobre reclamado hoy";
    };

    getDailyPackStatus().then(({ claimed }) => {
      if (claimed) markClaimed();
    });

    dailyPackBtn.addEventListener("click", async () => {
      try {
        await claimDailyPack();
        markClaimed();
      } catch {
        markClaimed();
      }
    });
  }
```

Losing the race (409) and any other request failure surfaced by `claimDailyPack()` both go through the same `catch` — `request()` in `api.ts` throws on any non-2xx status, so a 409 ("already claimed") and a genuine network hiccup arrive the same way here. Per the design spec, "already claimed" must never look like an error to the user, so this treats every rejection as "claimed" and disables the button. A user who clicks during a real network outage sees `✅ Sobre reclamado hoy` even though nothing was claimed — recoverable only by reloading the page, which re-checks `getDailyPackStatus()` and reverts the button if the claim didn't actually go through.

- [ ] **Step 6: Add styling to `src/style.css`**

Add after the existing `.donate-btn` / `@keyframes donate-pulse` block (around line 470):

```css
.btn-daily-pack {
  background: rgba(255, 86, 180, 0.15);
  border: 1px solid rgba(255, 86, 180, 0.4);
  color: var(--text-em);
}
.btn-daily-pack:hover:not(:disabled) {
  box-shadow: 0 0 20px rgba(255, 86, 180, 0.3);
  border-color: var(--pink);
}
.btn-daily-pack:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: var(--surface2);
  border-color: var(--border);
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- daily-pack-button`
Expected: PASS — all 5 cases (4 pages + admin absence) green.

- [ ] **Step 8: Commit**

```bash
git add src/api.ts src/user-header.ts src/style.css collection.html trade.html offers.html album.html src/daily-pack-button.test.ts
git commit -m "feat: add daily pack claim button to header"
```

---

## Task 4: Deploy

**Files:** none (ops step)

- [ ] **Step 1: Run full test suites**

Run: `npm test && npm run test:worker`
Expected: all suites PASS.

- [ ] **Step 2: Apply migrations to the remote D1 database**

Run: `npx wrangler d1 migrations apply twitch-cards-db --remote`
Expected: `0017_daily_pack_source.sql` and `0018_daily_pack_claims.sql` applied with no errors.

⚠️ This touches the production database — confirm with the user before running it, per the project's standing rule that DB migrations against production need explicit go-ahead even though routine code deploys don't.

- [ ] **Step 3: Deploy the Worker + frontend**

Run: `npm run deploy`
Expected: build succeeds, `wrangler deploy` reports success with the deployed URL.

- [ ] **Step 4: Push to remote**

Run: `git push origin main`
