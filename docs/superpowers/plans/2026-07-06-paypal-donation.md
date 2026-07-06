# PayPal Donation Auto-Grant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a donation button to the viewer header linking to PayPal.me/MrKlypp, and automatically grant packs when a donation ≥ threshold arrives via PayPal IPN, matched to an app user by a Twitch username the donor writes in the payment note.

**Architecture:** New PayPal IPN webhook (`worker/routes/webhook-paypal.ts`) parallel to the existing Twitch EventSub webhook, sharing the `grantPacks`/`upsertUser` helpers (extracted to `worker/lib/grants.ts`). Donations that can't be matched to a user land in a `paypal_donations` table with `status: 'unmatched'`, resolved manually from a new admin panel section.

**Tech Stack:** Hono routes on Cloudflare Workers, D1, vitest + `@cloudflare/vitest-pool-workers` (Miniflare) for worker tests, plain vitest for frontend DOM-string tests.

## Global Constraints

- Donation threshold and packs-per-threshold are admin-configurable, same pattern as `bits_threshold`/`bits_quantity` in `pack_grant_config`. Defaults: 2 (EUR), 1 pack.
- Only EUR donations auto-grant; other currencies land in the manual queue.
- Idempotency via `txn_id` primary key — PayPal can resend the same IPN.
- No PayPal API credentials available (personal account) — verification is the classic IPN postback handshake, no secret needed, but `receiver_email` must be checked against `PAYPAL_RECEIVER_EMAIL` to confirm the payment went to this account specifically.
- Donate button appears in `collection.html`, `trade.html`, `offers.html`, `album.html` — not `admin.html`.
- Reference spec: `docs/superpowers/specs/2026-07-06-paypal-donation-design.md`.

---

### Task 1: Extract shared grant helpers

**Files:**
- Create: `worker/lib/grants.ts`
- Modify: `worker/routes/webhook.ts`

**Interfaces:**
- Produces: `upsertUser(db: D1Database, userId: string, username: string): Promise<void>`, `grantPacks(db: D1Database, userId: string, quantity: number, source: string, tier: PackTier): Promise<void>` — both consumed by Task 4 (paypal webhook) and Task 5 (admin resolve endpoint).

- [ ] **Step 1: Create `worker/lib/grants.ts`**

```ts
import type { PackTier } from "./packs";

export async function upsertUser(db: D1Database, userId: string, username: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (twitch_id, username) VALUES (?, ?)
       ON CONFLICT(twitch_id) DO UPDATE SET username = excluded.username`
    )
    .bind(userId, username)
    .run();
}

export async function grantPacks(
  db: D1Database,
  userId: string,
  quantity: number,
  source: string,
  tier: PackTier
): Promise<void> {
  if (quantity < 1) return;
  const statements = Array.from({ length: quantity }, () =>
    db.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, ?, ?)").bind(userId, source, tier)
  );
  await db.batch(statements);
}
```

- [ ] **Step 2: Remove the local `upsertUser`/`grantPacks` definitions from `worker/routes/webhook.ts` and import from the new module**

In `worker/routes/webhook.ts`, delete the `upsertUser` and `grantPacks` function bodies (lines 25-47 in the current file) and add:

```ts
import { upsertUser, grantPacks } from "../lib/grants";
```

- [ ] **Step 3: Run the existing webhook test suite to confirm the extraction is behavior-preserving**

Run: `npx vitest run test/routes/webhook.test.ts --config vitest.workers.config.ts`
Expected: all existing tests still PASS (this is a pure refactor, no behavior change).

- [ ] **Step 4: Commit**

```bash
git add worker/lib/grants.ts worker/routes/webhook.ts
git commit -m "refactor: extract grantPacks/upsertUser to shared lib"
```

---

### Task 2: Migration — paypal_donations table + config columns

**Files:**
- Create: `migrations/0016_paypal_donations.sql`

**Interfaces:**
- Produces: table `paypal_donations(txn_id, amount, currency, note_raw, matched_username, matched_user_id, status, packs_granted, created_at)`; columns `pack_grant_config.paypal_threshold`, `pack_grant_config.paypal_quantity` — consumed by Task 4 and Task 5.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE pack_grant_config ADD COLUMN paypal_threshold INTEGER NOT NULL DEFAULT 2;
ALTER TABLE pack_grant_config ADD COLUMN paypal_quantity INTEGER NOT NULL DEFAULT 1;

CREATE TABLE paypal_donations (
  txn_id TEXT PRIMARY KEY,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  note_raw TEXT,
  matched_username TEXT,
  matched_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('granted', 'unmatched', 'ignored')),
  packs_granted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
```

- [ ] **Step 2: Run the worker test suite to confirm the migration applies cleanly**

Run: `npx vitest run test/routes/webhook.test.ts --config vitest.workers.config.ts`
Expected: PASS — `test/apply-migrations.ts` auto-applies every file in `migrations/`, so a syntax error here would fail every worker test, not just a dedicated one.

- [ ] **Step 3: Commit**

```bash
git add migrations/0016_paypal_donations.sql
git commit -m "feat: add paypal_donations table and config columns"
```

---

### Task 3: PayPal IPN parsing + verification lib

**Files:**
- Create: `worker/lib/paypal-ipn.ts`
- Test: `worker/lib/paypal-ipn.test.ts`

**Interfaces:**
- Produces: `parseIpnFields(rawBody: string): ParsedIpn` where `ParsedIpn = { txnId: string; amount: number; currency: string; paymentStatus: string; receiverEmail: string; note: string | null }`; `verifyIpn(rawBody: string): Promise<boolean>` — both consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseIpnFields, verifyIpn } from "./paypal-ipn";

describe("parseIpnFields", () => {
  it("extracts the core transaction fields", () => {
    const body = "txn_id=T1&mc_gross=6.00&mc_currency=EUR&payment_status=Completed&receiver_email=mrklypp%40example.com";
    expect(parseIpnFields(body)).toEqual({
      txnId: "T1",
      amount: 6,
      currency: "EUR",
      paymentStatus: "Completed",
      receiverEmail: "mrklypp@example.com",
      note: null,
    });
  });

  it("picks memo as the note when present", () => {
    const body = "txn_id=T1&mc_gross=2&mc_currency=EUR&payment_status=Completed&receiver_email=a%40b.com&memo=MrKlypp";
    expect(parseIpnFields(body).note).toBe("MrKlypp");
  });

  it("falls back to note field when memo is absent", () => {
    const body = "txn_id=T1&mc_gross=2&mc_currency=EUR&payment_status=Completed&receiver_email=a%40b.com&note=MrKlypp";
    expect(parseIpnFields(body).note).toBe("MrKlypp");
  });

  it("returns null note when neither field is present or both are blank", () => {
    const body = "txn_id=T1&mc_gross=2&mc_currency=EUR&payment_status=Completed&receiver_email=a%40b.com&memo=&note=";
    expect(parseIpnFields(body).note).toBeNull();
  });
});

describe("verifyIpn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns true when PayPal responds VERIFIED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("VERIFIED"))
    );
    expect(await verifyIpn("txn_id=T1")).toBe(true);
  });

  it("returns false when PayPal responds INVALID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("INVALID"))
    );
    expect(await verifyIpn("txn_id=T1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run worker/lib/paypal-ipn.test.ts --config vitest.workers.config.ts`
Expected: FAIL — `worker/lib/paypal-ipn.ts` does not exist yet.

- [ ] **Step 3: Implement**

```ts
export interface ParsedIpn {
  txnId: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  receiverEmail: string;
  note: string | null;
}

const NOTE_FIELDS = ["memo", "note", "item_name"];

export function parseIpnFields(rawBody: string): ParsedIpn {
  const params = new URLSearchParams(rawBody);
  let note: string | null = null;
  for (const field of NOTE_FIELDS) {
    const value = params.get(field);
    if (value && value.trim()) {
      note = value.trim();
      break;
    }
  }
  return {
    txnId: params.get("txn_id") ?? "",
    amount: Number(params.get("mc_gross") ?? "0"),
    currency: params.get("mc_currency") ?? "",
    paymentStatus: params.get("payment_status") ?? "",
    receiverEmail: params.get("receiver_email") ?? "",
    note,
  };
}

export async function verifyIpn(rawBody: string): Promise<boolean> {
  const res = await fetch("https://ipnpb.paypal.com/cgi-bin/webscr", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `cmd=_notify-validate&${rawBody}`,
  });
  const text = await res.text();
  return text === "VERIFIED";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run worker/lib/paypal-ipn.test.ts --config vitest.workers.config.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/lib/paypal-ipn.ts worker/lib/paypal-ipn.test.ts
git commit -m "feat: add PayPal IPN parsing and verification"
```

---

### Task 4: PayPal IPN webhook route

**Files:**
- Create: `worker/routes/webhook-paypal.ts`
- Modify: `worker/index.ts`, `worker/types.ts`, `.dev.vars.example`
- Test: `test/routes/webhook-paypal.test.ts`

**Interfaces:**
- Consumes: `parseIpnFields`, `verifyIpn` from `worker/lib/paypal-ipn.ts` (Task 3); `grantPacks` from `worker/lib/grants.ts` (Task 1); table/columns from Task 2.
- Produces: `POST /webhook/paypal-ipn` route, mounted alongside the existing `/webhook/eventsub`.

- [ ] **Step 1: Add `PAYPAL_RECEIVER_EMAIL` to the Env type and dev vars template**

In `worker/types.ts`, add to the `Env` interface:

```ts
  PAYPAL_RECEIVER_EMAIL: string;
```

In `.dev.vars.example`, append:

```
PAYPAL_RECEIVER_EMAIL=
```

- [ ] **Step 2: Write the failing tests**

```ts
import { env } from "cloudflare:test";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import app from "../../worker";
import * as paypalIpn from "../../worker/lib/paypal-ipn";

const RECEIVER = "mrklypp@example.com";

function ipnBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM packs");
  await env.DB.exec("DELETE FROM users");
  await env.DB.exec("DELETE FROM paypal_donations");
  await env.DB.exec(
    "UPDATE pack_grant_config SET paypal_threshold = 2, paypal_quantity = 1 WHERE id = 1"
  );
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("42", "mrklypp").run();
  env.PAYPAL_RECEIVER_EMAIL = RECEIVER;
  vi.spyOn(paypalIpn, "verifyIpn").mockResolvedValue(true);
});

afterEach(() => vi.restoreAllMocks());

it("grants a pack when a valid EUR donation matches a username in the note", async () => {
  const body = ipnBody({
    txn_id: "T1",
    mc_gross: "2.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  const res = await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  expect(res.status).toBe(200);
  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?").bind("42").all();
  expect(packs.results).toEqual([{ source: "paypal", tier: "apoyo" }]);
  const donation = await env.DB.prepare("SELECT status, packs_granted FROM paypal_donations WHERE txn_id = ?")
    .bind("T1")
    .first();
  expect(donation).toEqual({ status: "granted", packs_granted: 1 });
});

it("scales packs granted with the donation amount", async () => {
  const body = ipnBody({
    txn_id: "T2",
    mc_gross: "6.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const packs = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("42").all();
  expect(packs.results).toHaveLength(3);
});

it("does not grant when IPN verification fails", async () => {
  vi.spyOn(paypalIpn, "verifyIpn").mockResolvedValue(false);
  const body = ipnBody({
    txn_id: "T3",
    mc_gross: "2.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  const res = await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  expect(res.status).toBe(200);
  const packs = await env.DB.prepare("SELECT * FROM packs").all();
  expect(packs.results).toHaveLength(0);
  const donation = await env.DB.prepare("SELECT * FROM paypal_donations WHERE txn_id = ?").bind("T3").first();
  expect(donation).toBeNull();
});

it("does not grant when receiver_email does not match", async () => {
  const body = ipnBody({
    txn_id: "T4",
    mc_gross: "2.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: "someone-else@example.com",
    memo: "mrklypp",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const packs = await env.DB.prepare("SELECT * FROM packs").all();
  expect(packs.results).toHaveLength(0);
});

it("ignores a repeated txn_id instead of granting twice", async () => {
  const body = ipnBody({
    txn_id: "T5",
    mc_gross: "2.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);
  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const packs = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("42").all();
  expect(packs.results).toHaveLength(1);
});

it("marks the donation unmatched when the note has no matching username", async () => {
  const body = ipnBody({
    txn_id: "T6",
    mc_gross: "2.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "nosuchuser",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const donation = await env.DB.prepare("SELECT status FROM paypal_donations WHERE txn_id = ?")
    .bind("T6")
    .first<{ status: string }>();
  expect(donation?.status).toBe("unmatched");
  const packs = await env.DB.prepare("SELECT * FROM packs").all();
  expect(packs.results).toHaveLength(0);
});

it("marks the donation unmatched when the currency is not EUR", async () => {
  const body = ipnBody({
    txn_id: "T7",
    mc_gross: "10.00",
    mc_currency: "USD",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const donation = await env.DB.prepare("SELECT status FROM paypal_donations WHERE txn_id = ?")
    .bind("T7")
    .first<{ status: string }>();
  expect(donation?.status).toBe("unmatched");
});

it("marks the donation ignored when the amount is below threshold", async () => {
  const body = ipnBody({
    txn_id: "T8",
    mc_gross: "1.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const donation = await env.DB.prepare("SELECT status FROM paypal_donations WHERE txn_id = ?")
    .bind("T8")
    .first<{ status: string }>();
  expect(donation?.status).toBe("ignored");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/routes/webhook-paypal.test.ts --config vitest.workers.config.ts`
Expected: FAIL — route does not exist yet (404s).

- [ ] **Step 4: Implement `worker/routes/webhook-paypal.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "../types";
import * as paypalIpn from "../lib/paypal-ipn";
import { grantPacks } from "../lib/grants";

const webhookPaypal = new Hono<{ Bindings: Env }>();

interface PaypalConfig {
  paypal_threshold: number;
  paypal_quantity: number;
}

async function getPaypalConfig(db: D1Database): Promise<PaypalConfig> {
  const row = await db
    .prepare("SELECT paypal_threshold, paypal_quantity FROM pack_grant_config WHERE id = 1")
    .first<PaypalConfig>();
  return row!;
}

async function recordDonation(
  db: D1Database,
  txnId: string,
  amount: number,
  currency: string,
  note: string | null,
  status: "granted" | "unmatched" | "ignored",
  matchedUsername: string | null,
  matchedUserId: string | null,
  packsGranted: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO paypal_donations
        (txn_id, amount, currency, note_raw, matched_username, matched_user_id, status, packs_granted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(txnId, amount, currency, note, matchedUsername, matchedUserId, status, packsGranted)
    .run();
}

webhookPaypal.post("/paypal-ipn", async (c) => {
  const rawBody = await c.req.text();

  const verified = await paypalIpn.verifyIpn(rawBody);
  if (!verified) return c.json({ ok: true }, 200);

  const fields = paypalIpn.parseIpnFields(rawBody);
  if (fields.receiverEmail !== c.env.PAYPAL_RECEIVER_EMAIL) return c.json({ ok: true }, 200);
  if (fields.paymentStatus !== "Completed") return c.json({ ok: true }, 200);
  if (!fields.txnId) return c.json({ ok: true }, 200);

  const existing = await c.env.DB.prepare("SELECT txn_id FROM paypal_donations WHERE txn_id = ?")
    .bind(fields.txnId)
    .first();
  if (existing) return c.json({ ok: true }, 200);

  const config = await getPaypalConfig(c.env.DB);

  if (fields.currency !== "EUR") {
    await recordDonation(c.env.DB, fields.txnId, fields.amount, fields.currency, fields.note, "unmatched", null, null, 0);
    return c.json({ ok: true }, 200);
  }
  if (fields.amount < config.paypal_threshold) {
    await recordDonation(c.env.DB, fields.txnId, fields.amount, fields.currency, fields.note, "ignored", null, null, 0);
    return c.json({ ok: true }, 200);
  }

  const user = fields.note
    ? await c.env.DB.prepare("SELECT twitch_id, username FROM users WHERE LOWER(username) = LOWER(?)")
        .bind(fields.note)
        .first<{ twitch_id: string; username: string }>()
    : null;

  if (!user) {
    await recordDonation(c.env.DB, fields.txnId, fields.amount, fields.currency, fields.note, "unmatched", fields.note, null, 0);
    return c.json({ ok: true }, 200);
  }

  const packs = Math.floor(fields.amount / config.paypal_threshold) * config.paypal_quantity;
  await grantPacks(c.env.DB, user.twitch_id, packs, "paypal", "apoyo");
  await recordDonation(c.env.DB, fields.txnId, fields.amount, fields.currency, fields.note, "granted", user.username, user.twitch_id, packs);

  return c.json({ ok: true }, 200);
});

export default webhookPaypal;
```

Note: mirrors the existing `import * as twitch from "../lib/twitch"` pattern used in `worker/routes/admin.ts`/`auth.ts`, which is what makes `vi.spyOn(paypalIpn, "verifyIpn")` in the test work reliably.

- [ ] **Step 5: Mount the route in `worker/index.ts`**

```ts
import webhookPaypal from "./routes/webhook-paypal";
```

```ts
app.route("/webhook", webhookPaypal);
```

(add both lines near the existing `webhook` import/mount)

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/routes/webhook-paypal.test.ts --config vitest.workers.config.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add worker/routes/webhook-paypal.ts worker/index.ts worker/types.ts .dev.vars.example test/routes/webhook-paypal.test.ts
git commit -m "feat: auto-grant packs from PayPal donations via IPN"
```

---

### Task 5: Admin endpoints — list and resolve unmatched donations

**Files:**
- Modify: `worker/routes/admin.ts`
- Test: `test/routes/admin.test.ts`

**Interfaces:**
- Consumes: `grantPacks` from `worker/lib/grants.ts` (Task 1).
- Produces: `GET /api/admin/paypal-donations?status=unmatched`, `POST /api/admin/paypal-donations/:txnId/resolve`; extends `PackGrantConfig` (both route and the existing `GET`/`PUT /api/admin/pack-grant-config`) with `paypalThreshold`/`paypalQuantity`.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/admin.test.ts` (reuses the file's existing `adminCookie()` helper and `beforeEach` seeding `viewer1`/`viewer2` as `twitch_id` `"1"`/`"2"`):

```ts
it("lists unmatched paypal donations", async () => {
  await env.DB.prepare(
    `INSERT INTO paypal_donations (txn_id, amount, currency, note_raw, status, packs_granted)
     VALUES ('T1', 2, 'EUR', 'typo-user', 'unmatched', 0)`
  ).run();

  const res = await app.request(
    "/api/admin/paypal-donations?status=unmatched",
    { headers: { Cookie: await adminCookie() } },
    env
  );

  expect(res.status).toBe(200);
  const body = await res.json<{ donations: { txnId: string; noteRaw: string }[] }>();
  expect(body.donations).toEqual([expect.objectContaining({ txnId: "T1", noteRaw: "typo-user" })]);
});

it("resolves an unmatched donation by granting packs to the chosen user", async () => {
  await env.DB.prepare(
    `INSERT INTO paypal_donations (txn_id, amount, currency, note_raw, status, packs_granted)
     VALUES ('T2', 2, 'EUR', 'typo-user', 'unmatched', 0)`
  ).run();

  const res = await app.request(
    "/api/admin/paypal-donations/T2/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await adminCookie() },
      body: JSON.stringify({ twitchId: "1", quantity: 1 }),
    },
    env
  );

  expect(res.status).toBe(200);
  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?").bind("1").all();
  expect(packs.results).toEqual([{ source: "paypal_manual", tier: "apoyo" }]);
  const donation = await env.DB.prepare("SELECT status, matched_user_id FROM paypal_donations WHERE txn_id = ?")
    .bind("T2")
    .first();
  expect(donation).toEqual({ status: "granted", matched_user_id: "1" });
});

it("rejects resolving a donation that was already granted", async () => {
  await env.DB.prepare(
    `INSERT INTO paypal_donations (txn_id, amount, currency, status, packs_granted)
     VALUES ('T3', 2, 'EUR', 'granted', 1)`
  ).run();

  const res = await app.request(
    "/api/admin/paypal-donations/T3/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await adminCookie() },
      body: JSON.stringify({ twitchId: "1", quantity: 1 }),
    },
    env
  );

  expect(res.status).toBe(409);
});

it("includes paypalThreshold and paypalQuantity in the pack grant config", async () => {
  const res = await app.request("/api/admin/pack-grant-config", { headers: { Cookie: await adminCookie() } }, env);
  const body = await res.json<{ config: { paypalThreshold: number; paypalQuantity: number } }>();
  expect(body.config.paypalThreshold).toBe(2);
  expect(body.config.paypalQuantity).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/routes/admin.test.ts --config vitest.workers.config.ts`
Expected: FAIL — new endpoints don't exist, config fields undefined.

- [ ] **Step 3: Implement in `worker/routes/admin.ts`**

Add the import at the top:

```ts
import { grantPacks } from "../lib/grants";
```

Add after the existing `grant-packs` route:

```ts
admin.get("/paypal-donations", requireAdmin, async (c) => {
  const status = c.req.query("status") ?? "unmatched";
  const donations = await c.env.DB.prepare(
    `SELECT txn_id AS txnId, amount, currency, note_raw AS noteRaw, created_at AS createdAt
     FROM paypal_donations WHERE status = ? ORDER BY created_at DESC LIMIT 50`
  )
    .bind(status)
    .all<{ txnId: string; amount: number; currency: string; noteRaw: string | null; createdAt: string }>();
  return c.json({ donations: donations.results });
});

admin.post("/paypal-donations/:txnId/resolve", requireAdmin, async (c) => {
  const txnId = c.req.param("txnId");
  const body = await c.req
    .json<{ twitchId?: string; quantity?: number }>()
    .catch(() => ({}) as { twitchId?: string; quantity?: number });
  const { twitchId, quantity } = body;

  if (!twitchId || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return c.json({ error: "Invalid twitchId or quantity" }, 400);
  }

  const donation = await c.env.DB.prepare("SELECT status FROM paypal_donations WHERE txn_id = ?")
    .bind(txnId)
    .first<{ status: string }>();
  if (!donation) return c.json({ error: "Donation not found" }, 404);
  if (donation.status === "granted") return c.json({ error: "Already granted" }, 409);

  const user = await c.env.DB.prepare("SELECT twitch_id, username FROM users WHERE twitch_id = ?")
    .bind(twitchId)
    .first<{ twitch_id: string; username: string }>();
  if (!user) return c.json({ error: "User not found" }, 404);

  await grantPacks(c.env.DB, twitchId, quantity, "paypal_manual", "apoyo");
  await c.env.DB.prepare(
    `UPDATE paypal_donations SET status = 'granted', matched_user_id = ?, matched_username = ?, packs_granted = ?
     WHERE txn_id = ?`
  )
    .bind(twitchId, user.username, quantity, txnId)
    .run();

  return c.json({ ok: true });
});
```

Modify the existing `PackGrantConfig` interface and both `pack-grant-config` handlers:

```ts
interface PackGrantConfig {
  rewardQuantity: number;
  bitsThreshold: number;
  bitsQuantity: number;
  subQuantity: number;
  giftSubMultiplier: number;
  paypalThreshold: number;
  paypalQuantity: number;
}
```

In `admin.get("/pack-grant-config", ...)`, extend the SELECT:

```ts
    `SELECT reward_quantity AS rewardQuantity, bits_threshold AS bitsThreshold, bits_quantity AS bitsQuantity,
            sub_quantity AS subQuantity, gift_sub_multiplier AS giftSubMultiplier,
            paypal_threshold AS paypalThreshold, paypal_quantity AS paypalQuantity
     FROM pack_grant_config WHERE id = 1`
```

In `admin.put("/pack-grant-config", ...)`, destructure and validate the two new fields, and extend the UPDATE:

```ts
  const { rewardQuantity, bitsThreshold, bitsQuantity, subQuantity, giftSubMultiplier, paypalThreshold, paypalQuantity } =
    body;
```

```ts
  if (
    !isValidCount(rewardQuantity) ||
    !isValidThreshold(bitsThreshold) ||
    !isValidCount(bitsQuantity) ||
    !isValidCount(subQuantity) ||
    !isValidCount(giftSubMultiplier) ||
    !isValidThreshold(paypalThreshold) ||
    !isValidCount(paypalQuantity)
  ) {
    return c.json({ error: "Invalid config" }, 400);
  }
```

```ts
  await c.env.DB.prepare(
    `UPDATE pack_grant_config
     SET reward_quantity = ?, bits_threshold = ?, bits_quantity = ?, sub_quantity = ?, gift_sub_multiplier = ?,
         paypal_threshold = ?, paypal_quantity = ?
     WHERE id = 1`
  )
    .bind(rewardQuantity, bitsThreshold, bitsQuantity, subQuantity, giftSubMultiplier, paypalThreshold, paypalQuantity)
    .run();
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/routes/admin.test.ts --config vitest.workers.config.ts`
Expected: PASS (all existing admin tests + 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add worker/routes/admin.ts test/routes/admin.test.ts
git commit -m "feat: admin endpoints to review and resolve paypal donations"
```

---

### Task 6: Donate button in the viewer header

**Files:**
- Modify: `collection.html`, `trade.html`, `offers.html`, `album.html`, `src/style.css`
- Test: `src/donate-button.test.ts`

**Interfaces:**
- None (static markup + CSS, no TS module).

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const PAGES = ["collection.html", "trade.html", "offers.html", "album.html"];

describe("donate button", () => {
  for (const page of PAGES) {
    it(`is present with the correct href in ${page}`, () => {
      const html = readFileSync(page, "utf-8");
      expect(html).toMatch(
        /<a class="donate-btn" href="https:\/\/www\.paypal\.com\/paypalme\/MrKlypp" target="_blank"/
      );
    });
  }

  it("is not present in admin.html", () => {
    const html = readFileSync("admin.html", "utf-8");
    expect(html).not.toMatch(/donate-btn/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/donate-button.test.ts`
Expected: FAIL — button markup doesn't exist yet in any page.

- [ ] **Step 3: Add the button to each of the 4 viewer pages**

In `collection.html`, `trade.html`, `offers.html`, `album.html`, inside `<div class="page-header-user">`, immediately before the `<img id="user-avatar" ...>` line, insert:

```html
        <a
          class="donate-btn"
          href="https://www.paypal.com/paypalme/MrKlypp"
          target="_blank"
          rel="noopener"
          title="Incluye tu usuario de Twitch en la nota del pago para recibir tu sobre automáticamente"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 21s-6.5-4.35-9.3-8.28C.86 10.36 1.2 7 4 5.5c2.1-1.13 4.5-.5 5.7 1.2L12 9.3l2.3-2.6c1.2-1.7 3.6-2.33 5.7-1.2 2.8 1.5 3.14 4.86 1.3 7.22C18.5 16.65 12 21 12 21z" />
          </svg>
          Donar
        </a>
```

- [ ] **Step 4: Style it in `src/style.css`**

```css
.donate-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.9rem;
  border-radius: 100px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  font-size: 0.8rem;
  color: var(--text-em);
  background: linear-gradient(135deg, rgba(255, 86, 180, 0.25), rgba(0, 204, 255, 0.25));
  border: 1px solid rgba(255, 86, 180, 0.4);
  box-shadow: 0 0 12px rgba(255, 86, 180, 0.25);
  animation: pulse 2.4s infinite;
  transition: box-shadow 0.18s, transform 0.12s;
}
.donate-btn:hover {
  box-shadow: 0 0 20px rgba(255, 86, 180, 0.45), 0 0 20px rgba(0, 204, 255, 0.25);
  transform: translateY(-1px);
}
```

(the `pulse` keyframe already exists in the global design system section of `src/style.css`)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/donate-button.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add collection.html trade.html offers.html album.html src/style.css src/donate-button.test.ts
git commit -m "feat: add donation button to viewer header"
```

---

### Task 7: Admin panel UI for unmatched donations + paypal config fields

**Files:**
- Modify: `admin.html`, `src/admin.ts`

**Interfaces:**
- Consumes: `GET /api/admin/paypal-donations?status=unmatched`, `POST /api/admin/paypal-donations/:txnId/resolve`, extended `PackGrantConfig` (Task 5).

- [ ] **Step 1: Add markup to `admin.html`**

Add a new `<div class="card span-2">` right after the "Configuración de sobres automáticos" card, and two new config fields inside that existing card's `.cfg-fields`:

```html
              <label>
                € por sobre (PayPal)
                <input class="input" id="cfg-paypal-threshold" type="number" min="1" max="1000" />
              </label>
              <label>
                Sobres por umbral de PayPal
                <input class="input" id="cfg-paypal-quantity" type="number" min="0" max="1000" />
              </label>
```

New card:

```html
          <div class="card span-2">
            <h2>Donaciones de PayPal sin asignar</h2>
            <div id="paypal-donations-list" style="margin-top: 0.75rem;"></div>
          </div>
```

- [ ] **Step 2: Extend `src/admin.ts`**

Extend the `PackGrantConfig` interface:

```ts
interface PackGrantConfig {
  rewardQuantity: number;
  bitsThreshold: number;
  bitsQuantity: number;
  subQuantity: number;
  giftSubMultiplier: number;
  paypalThreshold: number;
  paypalQuantity: number;
}
```

Add a donation row type and rendering/resolve logic:

```ts
interface PaypalDonation {
  txnId: string;
  amount: number;
  currency: string;
  noteRaw: string | null;
  createdAt: string;
}

function renderPaypalDonations(donations: PaypalDonation[]): void {
  const container = document.getElementById("paypal-donations-list")!;
  if (donations.length === 0) {
    container.innerHTML = "<p>Sin donaciones pendientes.</p>";
    return;
  }
  const rows = donations.map((d) => {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap;";

    const info = document.createElement("span");
    info.textContent = `${d.amount} ${d.currency} · nota: "${d.noteRaw ?? "(vacía)"}" · ${d.createdAt}`;

    const usernameInput = document.createElement("input");
    usernameInput.className = "input";
    usernameInput.placeholder = "Twitch username";
    usernameInput.style.width = "160px";

    const quantityInput = document.createElement("input");
    quantityInput.className = "input";
    quantityInput.type = "number";
    quantityInput.min = "1";
    quantityInput.max = "50";
    quantityInput.value = "1";
    quantityInput.style.width = "70px";

    const resolveBtn = document.createElement("button");
    resolveBtn.className = "btn";
    resolveBtn.textContent = "Asignar";
    resolveBtn.addEventListener("click", () => resolveDonation(d.txnId, usernameInput, quantityInput, row));

    row.append(info, usernameInput, quantityInput, resolveBtn);
    return row;
  });
  container.replaceChildren(...rows);
}

async function resolveDonation(
  txnId: string,
  usernameInput: HTMLInputElement,
  quantityInput: HTMLInputElement,
  row: HTMLElement
): Promise<void> {
  const username = usernameInput.value.trim();
  if (!username) return;

  const lookup = await request<{ user: AdminUser }>("/lookup-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!lookup.ok) {
    if (lookup.status === 401) showLoginView();
    return;
  }

  const quantity = Number(quantityInput.value);
  const result = await request<{ ok: true }>(`/paypal-donations/${txnId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ twitchId: lookup.data.user.twitchId, quantity }),
  });
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  row.remove();
}

async function loadPaypalDonations(): Promise<void> {
  const result = await request<{ donations: PaypalDonation[] }>("/paypal-donations?status=unmatched");
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  renderPaypalDonations(result.data.donations);
}
```

In `loadPackGrantConfig`, add after the existing field assignments:

```ts
  (document.getElementById("cfg-paypal-threshold") as HTMLInputElement).value = String(config.paypalThreshold);
  (document.getElementById("cfg-paypal-quantity") as HTMLInputElement).value = String(config.paypalQuantity);
```

In `savePackGrantConfig`, add to the `config` object literal:

```ts
    paypalThreshold: Number((document.getElementById("cfg-paypal-threshold") as HTMLInputElement).value),
    paypalQuantity: Number((document.getElementById("cfg-paypal-quantity") as HTMLInputElement).value),
```

In `login()` and `init()`, call `await loadPaypalDonations();` alongside the existing `await loadPackGrantConfig();` calls.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add admin.html src/admin.ts
git commit -m "feat: admin UI to resolve unmatched paypal donations"
```

---

### Task 8: Full verification pass

- [ ] **Step 1: Run the full worker test suite**

Run: `npm run test:worker`
Expected: all tests PASS, including the new `worker/lib/paypal-ipn.test.ts`, `test/routes/webhook-paypal.test.ts`, and the extended `test/routes/admin.test.ts`.

- [ ] **Step 2: Run the full frontend test suite**

Run: `npm test`
Expected: all tests PASS, including the new `src/donate-button.test.ts`.

- [ ] **Step 3: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Deploy**

Apply the migration remotely, then build+deploy:

```bash
npx wrangler d1 execute twitch-cards-db --remote --command "ALTER TABLE pack_grant_config ADD COLUMN paypal_threshold INTEGER NOT NULL DEFAULT 2; ALTER TABLE pack_grant_config ADD COLUMN paypal_quantity INTEGER NOT NULL DEFAULT 1;"
```

Then run the full `migrations/0016_paypal_donations.sql` file remotely for the `paypal_donations` table (via `npx wrangler d1 migrations apply twitch-cards-db --remote`, matching the project's existing migration workflow), set the `PAYPAL_RECEIVER_EMAIL` secret with `npx wrangler secret put PAYPAL_RECEIVER_EMAIL`, then `npm run deploy`.

**Note:** after deploying, the PayPal IPN URL (`https://cards.mrklypp.com/webhook/paypal-ipn`) still needs to be entered manually in the PayPal account's Profile → Instant Payment Notifications settings — this is a one-time manual step outside the codebase, not something this plan can automate.
