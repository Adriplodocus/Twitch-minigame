# Colección de Cartas Twitch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web app where Twitch viewers log in, collect cards obtained from Channel Points redemptions (opened as "sobres" in the browser), and trade duplicates with other viewers.

**Architecture:** Single Cloudflare Worker (Hono router) serving both the API and a Vite-built static frontend via `@cloudflare/vite-plugin`. Cloudflare D1 (SQLite) holds all persistent state — no KV, no Durable Objects. Auth is a stateless signed JWT in an HttpOnly cookie (no server-side session storage). Twitch Channel Points redemptions arrive via an EventSub webhook; card catalog is authored offline (CSV + images) and seeded into D1 with a local CLI tool.

**Tech Stack:** Cloudflare Workers, D1, Hono, `jose` (JWT), Vite + TypeScript (vanilla, no framework), `@cloudflare/vite-plugin`, `@cloudflare/vitest-pool-workers` + Vitest 4 for testing, `tsx` for the local CLI tool.

## Global Constraints

- No KV, no Durable Objects — everything must run on Cloudflare's free tier (spec: stack decision).
- Sobres are granted on Channel Points redemption but only opened (RNG resolved) on demand in the web UI, not automatically (spec: apertura de sobre).
- Duplicate cards accumulate as `quantity` on the same row — never converted to another currency (spec: duplicados).
- Sobre size is fixed at 5 cards per open (spec: tamaño sobre).
- 4 rarity tiers (común/rara/épica/legendaria) with configurable weights, default 60/25/12/3 (spec: rareza).
- Trading between users is in scope for v1, not deferred (spec: trading).
- Card catalog v1 has no admin panel — managed via a local Node CLI script reading a CSV + an image folder (spec: catálogo).
- Frontend is Vite + TypeScript, no framework (spec: frontend).
- Only one Channel Points reward is wired up in v1 (spec: fuera de alcance).

---

## File Structure

```
TwitchMinigame/
  package.json
  tsconfig.json / tsconfig.app.json / tsconfig.worker.json / tsconfig.node.json
  wrangler.jsonc
  vite.config.ts              # dev/build: @cloudflare/vite-plugin
  vitest.config.ts            # plain Node tests (tools/catalog)
  vitest.workers.config.ts    # Workers-runtime tests (worker/, test/)
  migrations/0001_init.sql    # D1 schema
  index.html                  # login/landing page
  collection.html
  trade.html
  worker/
    index.ts                  # Hono app, mounts routes
    types.ts                  # Env interface, shared types
    middleware/auth.ts         # requireAuth middleware
    lib/
      jwt.ts
      twitch.ts                # OAuth + Helix + EventSub subscription calls
      eventsub.ts               # webhook signature verification
      packs.ts                  # weighted RNG pick
    routes/
      auth.ts
      webhook.ts
      collection.ts
      trade.ts
  test/
    apply-migrations.ts
    lib/jwt.test.ts
    lib/twitch.test.ts
    lib/eventsub.test.ts
    lib/packs.test.ts
    routes/auth.test.ts
    routes/webhook.test.ts
    routes/collection.test.ts
    routes/trade.test.ts
    index.test.ts
  tools/catalog/
    build-catalog.ts
    build-catalog.test.ts
    cards.csv                  # sample seed data
  public/
    cards/                     # card PNGs, served as static assets
      .gitkeep
  src/
    style.css                  # brand design system
    api.ts                     # fetch wrapper for /api
    login.ts                   # entry for index.html
    collection.ts               # entry for collection.html
    trade.ts                    # entry for trade.html
  .dev.vars.example
  .gitignore
```

---

### Task 1: Project scaffold, D1 schema, minimal Worker

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`, `tsconfig.app.json`, `tsconfig.worker.json`, `tsconfig.node.json`
- Create: `wrangler.jsonc`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `vitest.workers.config.ts`
- Create: `migrations/0001_init.sql`
- Create: `worker/types.ts`
- Create: `worker/index.ts`
- Create: `test/apply-migrations.ts`
- Create: `test/index.test.ts`
- Create: `.dev.vars.example`
- Create: `.gitignore`
- Create: `index.html` (placeholder)

**Interfaces:**
- Produces: `Env` interface (`worker/types.ts`) — `DB: D1Database`, `ASSETS: Fetcher`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_REDIRECT_URI`, `TWITCH_BROADCASTER_REDIRECT_URI`, `TWITCH_EVENTSUB_SECRET`, `TWITCH_BROADCASTER_ID`, `TWITCH_REWARD_ID`, `JWT_SECRET` (all `string` except `DB`/`ASSETS`).
- Produces: default-exported Hono `app` from `worker/index.ts` with `Bindings: Env`, used by every later route/test via `import app from "../../worker"`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "twitch-card-collection",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "deploy": "vite build && wrangler deploy",
    "test": "vitest run --config vitest.config.ts",
    "test:worker": "vitest run --config vitest.workers.config.ts",
    "catalog:build": "tsx tools/catalog/build-catalog.ts"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "jose": "^5.9.0"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "latest",
    "@cloudflare/vitest-pool-workers": "^0.17.0",
    "@cloudflare/workers-types": "latest",
    "@types/node": "^22.0.0",
    "typescript": "^5.8.0",
    "tsx": "^4.19.0",
    "vite": "^6.0.0",
    "vitest": "^4.1.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create `wrangler.jsonc`**

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "twitch-card-collection",
  "compatibility_date": "2025-01-01",
  "main": "./worker/index.ts",
  "assets": {
    "run_worker_first": ["/api/*", "/webhook/*"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "twitch-cards-db",
      "database_id": "REPLACE_WITH_D1_DATABASE_ID",
      "migrations_dir": "migrations"
    }
  ]
}
```

- [ ] **Step 3: Create `migrations/0001_init.sql`**

```sql
CREATE TABLE users (
  twitch_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
  image_path TEXT NOT NULL
);

CREATE TABLE user_cards (
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  card_id TEXT NOT NULL REFERENCES cards(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  opened_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_packs_user ON packs(user_id);

CREATE TABLE pack_cards (
  pack_id INTEGER NOT NULL REFERENCES packs(id),
  card_id TEXT NOT NULL REFERENCES cards(id)
);

CREATE TABLE trade_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user TEXT NOT NULL REFERENCES users(twitch_id),
  to_user TEXT NOT NULL REFERENCES users(twitch_id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_offers_to_user ON trade_offers(to_user);
CREATE INDEX idx_trade_offers_from_user ON trade_offers(from_user);

CREATE TABLE trade_items (
  offer_id INTEGER NOT NULL REFERENCES trade_offers(id),
  side TEXT NOT NULL CHECK (side IN ('from', 'to')),
  card_id TEXT NOT NULL REFERENCES cards(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE broadcaster_credentials (
  twitch_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

- [ ] **Step 4: Create `worker/types.ts`**

```typescript
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TWITCH_REDIRECT_URI: string;
  TWITCH_BROADCASTER_REDIRECT_URI: string;
  TWITCH_EVENTSUB_SECRET: string;
  TWITCH_BROADCASTER_ID: string;
  TWITCH_REWARD_ID: string;
  JWT_SECRET: string;
}

export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface SessionUser {
  twitchId: string;
  username: string;
}
```

- [ ] **Step 5: Create minimal `worker/index.ts`**

```typescript
import { Hono } from "hono";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
```

- [ ] **Step 6: Create test infra files**

`test/apply-migrations.ts`:

```typescript
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`vitest.workers.config.ts`:

```typescript
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrationsPath = path.join(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["worker/**/*.test.ts", "test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
```

`vitest.config.ts` (plain Node, for the catalog CLI tool):

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tools/**/*.test.ts"],
  },
});
```

`test/index.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import app from "../worker";

it("responds to health check", async () => {
  const res = await app.request("/api/health", {}, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
```

- [ ] **Step 7: Create remaining config/scaffold files**

`tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.worker.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

`tsconfig.app.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`tsconfig.worker.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["worker", "test"]
}
```

`tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["tools", "vite.config.ts", "vitest.config.ts", "vitest.workers.config.ts"]
}
```

`vite.config.ts`:

```typescript
import path from "node:path";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        collection: path.resolve(__dirname, "collection.html"),
        trade: path.resolve(__dirname, "trade.html"),
      },
    },
  },
});
```

`.dev.vars.example`:

```
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_REDIRECT_URI=http://localhost:5173/api/auth/callback
TWITCH_BROADCASTER_REDIRECT_URI=http://localhost:5173/api/auth/broadcaster-callback
TWITCH_EVENTSUB_SECRET=
TWITCH_BROADCASTER_ID=
TWITCH_REWARD_ID=
JWT_SECRET=
```

`.gitignore`:

```
node_modules/
dist/
.wrangler/
.dev.vars
catalog.json
tools/catalog/seed-cards.sql
```

`index.html` (placeholder, replaced in Task 13):

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Card Collection</title></head>
  <body><p>Coming soon.</p></body>
</html>
```

- [ ] **Step 8: Install dependencies**

Run: `npm install`
Expected: installs without errors, creates `package-lock.json`

- [ ] **Step 9: Run worker test to verify it fails (no D1 database created yet)**

Run: `npm run test:worker`
Expected: FAIL — either a binding/migration error or module resolution error, since dependencies were just installed and nothing has run yet

- [ ] **Step 10: Fix and verify test passes**

The scaffold above is already the minimal implementation — re-run:

Run: `npm run test:worker`
Expected: PASS — 1 test passed (`responds to health check`)

- [ ] **Step 11: Commit**

```bash
git add package.json tsconfig.json tsconfig.app.json tsconfig.worker.json tsconfig.node.json wrangler.jsonc vite.config.ts vitest.config.ts vitest.workers.config.ts migrations worker test .dev.vars.example .gitignore index.html package-lock.json
git commit -m "chore: scaffold Worker, D1 schema, and test infra"
```

---

### Task 2: JWT session helper

**Files:**
- Create: `worker/lib/jwt.ts`
- Test: `test/lib/jwt.test.ts`

**Interfaces:**
- Consumes: `SessionUser` type from `worker/types.ts` (`{ twitchId: string; username: string }`).
- Produces: `signSession(user: SessionUser, secret: string): Promise<string>` and `verifySession(token: string, secret: string): Promise<SessionUser | null>`, used by `worker/middleware/auth.ts` (Task 6) and `worker/routes/auth.ts` (Task 6).

- [ ] **Step 1: Write the failing test**

```typescript
// test/lib/jwt.test.ts
import { it, expect } from "vitest";
import { signSession, verifySession } from "../../worker/lib/jwt";

const SECRET = "test-secret-value-with-enough-length";

it("round-trips a signed session", async () => {
  const token = await signSession({ twitchId: "123", username: "mrklypp" }, SECRET);
  const session = await verifySession(token, SECRET);
  expect(session).toEqual({ twitchId: "123", username: "mrklypp" });
});

it("rejects a token signed with a different secret", async () => {
  const token = await signSession({ twitchId: "123", username: "mrklypp" }, SECRET);
  const session = await verifySession(token, "a-completely-different-secret");
  expect(session).toBeNull();
});

it("rejects a malformed token", async () => {
  const session = await verifySession("not-a-jwt", SECRET);
  expect(session).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:worker -- jwt`
Expected: FAIL with "Cannot find module '../../worker/lib/jwt'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/lib/jwt.ts
import { SignJWT, jwtVerify } from "jose";
import type { SessionUser } from "../types";

function getKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(user: SessionUser, secret: string): Promise<string> {
  return new SignJWT({ twitchId: user.twitchId, username: user.username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getKey(secret));
}

export async function verifySession(token: string, secret: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, getKey(secret));
    if (typeof payload.twitchId !== "string" || typeof payload.username !== "string") {
      return null;
    }
    return { twitchId: payload.twitchId, username: payload.username };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:worker -- jwt`
Expected: PASS — 3 tests passed

- [ ] **Step 5: Commit**

```bash
git add worker/lib/jwt.ts test/lib/jwt.test.ts
git commit -m "feat: add JWT session sign/verify helper"
```

---

### Task 3: Twitch OAuth + Helix + EventSub subscription helpers

**Files:**
- Create: `worker/lib/twitch.ts`
- Test: `test/lib/twitch.test.ts`

**Interfaces:**
- Produces:
  - `buildAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string; scopes: string[] }): string`
  - `exchangeCodeForToken(opts: { clientId: string; clientSecret: string; redirectUri: string; code: string }, fetchImpl?: typeof fetch): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>`
  - `getTwitchUser(accessToken: string, clientId: string, fetchImpl?: typeof fetch): Promise<{ id: string; login: string; profileImageUrl: string }>`
  - `createEventSubSubscription(opts: { accessToken: string; clientId: string; broadcasterId: string; rewardId: string; callbackUrl: string; secret: string }, fetchImpl?: typeof fetch): Promise<void>`
  - Consumed by `worker/routes/auth.ts` and `worker/routes/webhook.ts` (Task 6/7).

- [ ] **Step 1: Write the failing test**

```typescript
// test/lib/twitch.test.ts
import { it, expect, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getTwitchUser,
  createEventSubSubscription,
} from "../../worker/lib/twitch";

it("builds an authorize URL with required params", () => {
  const url = buildAuthorizeUrl({
    clientId: "abc",
    redirectUri: "https://example.com/callback",
    state: "xyz",
    scopes: [],
  });
  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
  expect(parsed.searchParams.get("client_id")).toBe("abc");
  expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
  expect(parsed.searchParams.get("state")).toBe("xyz");
  expect(parsed.searchParams.get("response_type")).toBe("code");
});

it("exchanges an auth code for tokens", async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 14400 }),
      { status: 200 }
    )
  );
  const result = await exchangeCodeForToken(
    { clientId: "abc", clientSecret: "s3cr3t", redirectUri: "https://example.com/callback", code: "code123" },
    fetchImpl as unknown as typeof fetch
  );
  expect(result).toEqual({ accessToken: "at", refreshToken: "rt", expiresIn: 14400 });
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://id.twitch.tv/oauth2/token",
    expect.objectContaining({ method: "POST" })
  );
});

it("fetches the authenticated Twitch user", async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(
      JSON.stringify({ data: [{ id: "42", login: "mrklypp", profile_image_url: "https://img" }] }),
      { status: 200 }
    )
  );
  const user = await getTwitchUser("at", "abc", fetchImpl as unknown as typeof fetch);
  expect(user).toEqual({ id: "42", login: "mrklypp", profileImageUrl: "https://img" });
});

it("creates an EventSub subscription", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 202 }));
  await createEventSubSubscription(
    {
      accessToken: "at",
      clientId: "abc",
      broadcasterId: "99",
      rewardId: "reward-1",
      callbackUrl: "https://example.com/webhook/eventsub",
      secret: "whsecret",
    },
    fetchImpl as unknown as typeof fetch
  );
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://api.twitch.tv/helix/eventsub/subscriptions",
    expect.objectContaining({ method: "POST" })
  );
  const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
  expect(body.type).toBe("channel.channel_points_custom_reward_redemption.add");
  expect(body.condition).toEqual({ broadcaster_user_id: "99", reward_id: "reward-1" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:worker -- twitch`
Expected: FAIL with "Cannot find module '../../worker/lib/twitch'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/lib/twitch.ts
export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", opts.state);
  if (opts.scopes.length > 0) url.searchParams.set("scope", opts.scopes.join(" "));
  return url.toString();
}

export async function exchangeCodeForToken(
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
  });
  const res = await fetchImpl("https://id.twitch.tv/oauth2/token", { method: "POST", body });
  if (!res.ok) throw new Error(`Twitch token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in };
}

export async function getTwitchUser(
  accessToken: string,
  clientId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ id: string; login: string; profileImageUrl: string }> {
  const res = await fetchImpl("https://api.twitch.tv/helix/users", {
    headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId },
  });
  if (!res.ok) throw new Error(`Twitch get user failed: ${res.status}`);
  const json = (await res.json()) as {
    data: { id: string; login: string; profile_image_url: string }[];
  };
  const user = json.data[0];
  return { id: user.id, login: user.login, profileImageUrl: user.profile_image_url };
}

export async function createEventSubSubscription(
  opts: {
    accessToken: string;
    clientId: string;
    broadcasterId: string;
    rewardId: string;
    callbackUrl: string;
    secret: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const res = await fetchImpl("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Client-Id": opts.clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: opts.broadcasterId, reward_id: opts.rewardId },
      transport: { method: "webhook", callback: opts.callbackUrl, secret: opts.secret },
    }),
  });
  if (!res.ok) throw new Error(`EventSub subscription creation failed: ${res.status}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:worker -- twitch`
Expected: PASS — 4 tests passed

- [ ] **Step 5: Commit**

```bash
git add worker/lib/twitch.ts test/lib/twitch.test.ts
git commit -m "feat: add Twitch OAuth, Helix, and EventSub subscription helpers"
```

---

### Task 4: EventSub webhook signature verification

**Files:**
- Create: `worker/lib/eventsub.ts`
- Test: `test/lib/eventsub.test.ts`

**Interfaces:**
- Produces: `verifyEventSubSignature(opts: { secret: string; messageId: string; timestamp: string; body: string; signatureHeader: string }): Promise<boolean>`, consumed by `worker/routes/webhook.ts` (Task 7).

- [ ] **Step 1: Write the failing test**

```typescript
// test/lib/eventsub.test.ts
import { it, expect } from "vitest";
import { verifyEventSubSignature } from "../../worker/lib/eventsub";

async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

it("accepts a correctly signed payload", async () => {
  const secret = "whsecret";
  const messageId = "msg-1";
  const timestamp = "2026-01-01T00:00:00Z";
  const body = JSON.stringify({ hello: "world" });
  const signatureHeader = await sign(secret, messageId + timestamp + body);

  const valid = await verifyEventSubSignature({ secret, messageId, timestamp, body, signatureHeader });
  expect(valid).toBe(true);
});

it("rejects a tampered payload", async () => {
  const secret = "whsecret";
  const messageId = "msg-1";
  const timestamp = "2026-01-01T00:00:00Z";
  const body = JSON.stringify({ hello: "world" });
  const signatureHeader = await sign(secret, messageId + timestamp + body);

  const valid = await verifyEventSubSignature({
    secret,
    messageId,
    timestamp,
    body: JSON.stringify({ hello: "tampered" }),
    signatureHeader,
  });
  expect(valid).toBe(false);
});

it("rejects a signature made with the wrong secret", async () => {
  const messageId = "msg-1";
  const timestamp = "2026-01-01T00:00:00Z";
  const body = JSON.stringify({ hello: "world" });
  const signatureHeader = await sign("wrong-secret", messageId + timestamp + body);

  const valid = await verifyEventSubSignature({ secret: "whsecret", messageId, timestamp, body, signatureHeader });
  expect(valid).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:worker -- eventsub`
Expected: FAIL with "Cannot find module '../../worker/lib/eventsub'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/lib/eventsub.ts
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyEventSubSignature(opts: {
  secret: string;
  messageId: string;
  timestamp: string;
  body: string;
  signatureHeader: string;
}): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(opts.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const message = opts.messageId + opts.timestamp + opts.body;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(`sha256=${hex}`, opts.signatureHeader);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:worker -- eventsub`
Expected: PASS — 3 tests passed

- [ ] **Step 5: Commit**

```bash
git add worker/lib/eventsub.ts test/lib/eventsub.test.ts
git commit -m "feat: add EventSub webhook signature verification"
```

---

### Task 5: Weighted pack RNG

**Files:**
- Create: `worker/lib/packs.ts`
- Test: `test/lib/packs.test.ts`

**Interfaces:**
- Consumes: `Rarity` type from `worker/types.ts`.
- Produces: `RARITY_WEIGHTS: Record<Rarity, number>` and `pickRandomCards<T extends { id: string; rarity: Rarity }>(catalog: T[], count: number, random?: () => number): T[]`, consumed by `worker/routes/collection.ts` (Task 8).

- [ ] **Step 1: Write the failing test**

```typescript
// test/lib/packs.test.ts
import { it, expect } from "vitest";
import { pickRandomCards, RARITY_WEIGHTS } from "../../worker/lib/packs";

const catalog = [
  { id: "c1", rarity: "common" as const },
  { id: "r1", rarity: "rare" as const },
  { id: "e1", rarity: "epic" as const },
  { id: "l1", rarity: "legendary" as const },
];

it("returns the requested number of cards", () => {
  const picks = pickRandomCards(catalog, 5, () => 0.5);
  expect(picks).toHaveLength(5);
});

it("picks the first card when random() returns 0", () => {
  const picks = pickRandomCards(catalog, 1, () => 0);
  expect(picks[0].id).toBe("c1");
});

it("picks the last card when random() returns just under 1", () => {
  const picks = pickRandomCards(catalog, 1, () => 0.999999);
  expect(picks[0].id).toBe("l1");
});

it("throws on an empty catalog", () => {
  expect(() => pickRandomCards([], 5)).toThrow();
});

it("defines descending weights per rarity tier", () => {
  expect(RARITY_WEIGHTS.common).toBeGreaterThan(RARITY_WEIGHTS.rare);
  expect(RARITY_WEIGHTS.rare).toBeGreaterThan(RARITY_WEIGHTS.epic);
  expect(RARITY_WEIGHTS.epic).toBeGreaterThan(RARITY_WEIGHTS.legendary);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:worker -- packs`
Expected: FAIL with "Cannot find module '../../worker/lib/packs'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/lib/packs.ts
import type { Rarity } from "../types";

export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 60,
  rare: 25,
  epic: 12,
  legendary: 3,
};

export function pickRandomCards<T extends { id: string; rarity: Rarity }>(
  catalog: T[],
  count: number,
  random: () => number = Math.random
): T[] {
  if (catalog.length === 0) throw new Error("Catalog is empty");
  const totalWeight = catalog.reduce((sum, card) => sum + RARITY_WEIGHTS[card.rarity], 0);
  const picks: T[] = [];
  for (let i = 0; i < count; i++) {
    let roll = random() * totalWeight;
    let chosen = catalog[catalog.length - 1];
    for (const card of catalog) {
      roll -= RARITY_WEIGHTS[card.rarity];
      if (roll <= 0) {
        chosen = card;
        break;
      }
    }
    picks.push(chosen);
  }
  return picks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:worker -- packs`
Expected: PASS — 5 tests passed

- [ ] **Step 5: Commit**

```bash
git add worker/lib/packs.ts test/lib/packs.test.ts
git commit -m "feat: add weighted pack RNG"
```

---

### Task 6: Auth routes (viewer login + broadcaster EventSub setup)

**Files:**
- Create: `worker/middleware/auth.ts`
- Create: `worker/routes/auth.ts`
- Modify: `worker/index.ts`
- Test: `test/routes/auth.test.ts`

**Interfaces:**
- Consumes: `signSession`/`verifySession` (Task 2), `buildAuthorizeUrl`/`exchangeCodeForToken`/`getTwitchUser`/`createEventSubSubscription` (Task 3).
- Produces: `requireAuth` middleware (sets Hono context variable `user: SessionUser`), consumed by `worker/routes/collection.ts` and `worker/routes/trade.ts` (Tasks 8/9/10). Mounts Hono sub-app at `/api/auth` with routes `GET /login`, `GET /callback`, `POST /logout`, `GET /broadcaster-login`, `GET /broadcaster-callback`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/routes/auth.test.ts
import { env } from "cloudflare:test";
import { it, expect, vi, beforeEach } from "vitest";
import app from "../../worker";
import * as twitch from "../../worker/lib/twitch";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM broadcaster_credentials");
  await env.DB.exec("DELETE FROM users");
});

it("redirects to Twitch authorize URL on login", async () => {
  const res = await app.request("/api/auth/login", { redirect: "manual" }, env);
  expect(res.status).toBe(302);
  const location = res.headers.get("Location") ?? "";
  expect(location).toContain("https://id.twitch.tv/oauth2/authorize");
  expect(res.headers.get("Set-Cookie")).toContain("oauth_state=");
});

it("rejects callback with mismatched state", async () => {
  const res = await app.request(
    "/api/auth/callback?code=abc&state=wrong",
    { headers: { Cookie: "oauth_state=expected" } },
    env
  );
  expect(res.status).toBe(400);
});

it("creates a user and sets a session cookie on valid callback", async () => {
  vi.spyOn(twitch, "exchangeCodeForToken").mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 14400,
  });
  vi.spyOn(twitch, "getTwitchUser").mockResolvedValue({
    id: "42",
    login: "mrklypp",
    profileImageUrl: "https://img",
  });

  const res = await app.request(
    "/api/auth/callback?code=abc&state=expected",
    { headers: { Cookie: "oauth_state=expected" }, redirect: "manual" },
    env
  );

  expect(res.status).toBe(302);
  expect(res.headers.get("Set-Cookie")).toContain("session=");

  const row = await env.DB.prepare("SELECT twitch_id, username FROM users WHERE twitch_id = ?")
    .bind("42")
    .first<{ twitch_id: string; username: string }>();
  expect(row).toEqual({ twitch_id: "42", username: "mrklypp" });

  vi.restoreAllMocks();
});

it("rejects broadcaster callback when the logged-in Twitch user is not the broadcaster", async () => {
  vi.spyOn(twitch, "exchangeCodeForToken").mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 14400,
  });
  vi.spyOn(twitch, "getTwitchUser").mockResolvedValue({
    id: "not-the-broadcaster",
    login: "someviewer",
    profileImageUrl: "https://img",
  });

  const res = await app.request(
    "/api/auth/broadcaster-callback?code=abc&state=expected",
    { headers: { Cookie: "broadcaster_oauth_state=expected" } },
    env
  );

  expect(res.status).toBe(403);
  vi.restoreAllMocks();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:worker -- auth`
Expected: FAIL with "Cannot find module '../../worker/routes/auth'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/middleware/auth.ts
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { verifySession } from "../lib/jwt";
import type { Env, SessionUser } from "../types";

export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: { user: SessionUser };
}>(async (c, next) => {
  const token = getCookie(c, "session");
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const session = await verifySession(token, c.env.JWT_SECRET);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", session);
  await next();
});
```

```typescript
// worker/routes/auth.ts
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { signSession } from "../lib/jwt";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getTwitchUser,
  createEventSubSubscription,
} from "../lib/twitch";

const auth = new Hono<{ Bindings: Env }>();

auth.get("/login", (c) => {
  const state = crypto.randomUUID();
  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const url = buildAuthorizeUrl({
    clientId: c.env.TWITCH_CLIENT_ID,
    redirectUri: c.env.TWITCH_REDIRECT_URI,
    state,
    scopes: [],
  });
  return c.redirect(url, 302);
});

auth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, "oauth_state");
  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: "Invalid OAuth state" }, 400);
  }

  const token = await exchangeCodeForToken({
    clientId: c.env.TWITCH_CLIENT_ID,
    clientSecret: c.env.TWITCH_CLIENT_SECRET,
    redirectUri: c.env.TWITCH_REDIRECT_URI,
    code,
  });
  const twitchUser = await getTwitchUser(token.accessToken, c.env.TWITCH_CLIENT_ID);

  await c.env.DB.prepare(
    `INSERT INTO users (twitch_id, username, avatar_url) VALUES (?, ?, ?)
     ON CONFLICT(twitch_id) DO UPDATE SET username = excluded.username, avatar_url = excluded.avatar_url`
  )
    .bind(twitchUser.id, twitchUser.login, twitchUser.profileImageUrl)
    .run();

  const sessionToken = await signSession(
    { twitchId: twitchUser.id, username: twitchUser.login },
    c.env.JWT_SECRET
  );
  deleteCookie(c, "oauth_state", { path: "/" });
  setCookie(c, "session", sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.redirect("/collection.html", 302);
});

auth.post("/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

auth.get("/broadcaster-login", (c) => {
  const state = crypto.randomUUID();
  setCookie(c, "broadcaster_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const url = buildAuthorizeUrl({
    clientId: c.env.TWITCH_CLIENT_ID,
    redirectUri: c.env.TWITCH_BROADCASTER_REDIRECT_URI,
    state,
    scopes: ["channel:read:redemptions"],
  });
  return c.redirect(url, 302);
});

auth.get("/broadcaster-callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, "broadcaster_oauth_state");
  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: "Invalid OAuth state" }, 400);
  }

  const token = await exchangeCodeForToken({
    clientId: c.env.TWITCH_CLIENT_ID,
    clientSecret: c.env.TWITCH_CLIENT_SECRET,
    redirectUri: c.env.TWITCH_BROADCASTER_REDIRECT_URI,
    code,
  });
  const twitchUser = await getTwitchUser(token.accessToken, c.env.TWITCH_CLIENT_ID);

  if (twitchUser.id !== c.env.TWITCH_BROADCASTER_ID) {
    return c.json({ error: "Only the broadcaster account can complete this step" }, 403);
  }

  const expiresAt = new Date(Date.now() + token.expiresIn * 1000).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO broadcaster_credentials (twitch_id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(twitch_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`
  )
    .bind(twitchUser.id, token.accessToken, token.refreshToken, expiresAt)
    .run();

  await createEventSubSubscription({
    accessToken: token.accessToken,
    clientId: c.env.TWITCH_CLIENT_ID,
    broadcasterId: c.env.TWITCH_BROADCASTER_ID,
    rewardId: c.env.TWITCH_REWARD_ID,
    callbackUrl: new URL("/webhook/eventsub", c.req.url).toString(),
    secret: c.env.TWITCH_EVENTSUB_SECRET,
  });

  deleteCookie(c, "broadcaster_oauth_state", { path: "/" });
  return c.json({ ok: true, message: "EventSub subscription created" });
});

export default auth;
```

Wire it into the app:

```typescript
// worker/index.ts
import { Hono } from "hono";
import type { Env } from "./types";
import auth from "./routes/auth";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", auth);

export default app;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:worker -- auth`
Expected: PASS — 4 tests passed

- [ ] **Step 5: Commit**

```bash
git add worker/middleware/auth.ts worker/routes/auth.ts worker/index.ts test/routes/auth.test.ts
git commit -m "feat: add viewer login and broadcaster EventSub setup routes"
```

---

### Task 7: EventSub webhook receiver

**Files:**
- Create: `worker/routes/webhook.ts`
- Modify: `worker/index.ts`
- Test: `test/routes/webhook.test.ts`

**Interfaces:**
- Consumes: `verifyEventSubSignature` (Task 4).
- Produces: Hono sub-app mounted at `/webhook`, route `POST /eventsub`, inserts rows into `packs`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/routes/webhook.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";

const SECRET = "test-eventsub-secret";

async function signBody(messageId: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(messageId + timestamp + body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM packs");
  await env.DB.exec("DELETE FROM users");
  env.TWITCH_EVENTSUB_SECRET = SECRET;
  env.TWITCH_REWARD_ID = "reward-1";
});

it("responds to webhook_callback_verification with the challenge", async () => {
  const body = JSON.stringify({ challenge: "abc123", subscription: {} });
  const messageId = "msg-1";
  const timestamp = new Date().toISOString();
  const signature = await signBody(messageId, timestamp, body);

  const res = await app.request(
    "/webhook/eventsub",
    {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": signature,
        "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
      },
    },
    env
  );

  expect(res.status).toBe(200);
  expect(await res.text()).toBe("abc123");
});

it("creates a pending pack on a matching reward redemption notification", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
    event: {
      user_id: "42",
      user_login: "mrklypp",
      user_name: "mrklypp",
      reward: { id: "reward-1" },
    },
  });
  const messageId = "msg-2";
  const timestamp = new Date().toISOString();
  const signature = await signBody(messageId, timestamp, body);

  const res = await app.request(
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

  expect(res.status).toBe(200);
  const pack = await env.DB.prepare("SELECT user_id, opened_at FROM packs WHERE user_id = ?")
    .bind("42")
    .first<{ user_id: string; opened_at: string | null }>();
  expect(pack).toEqual({ user_id: "42", opened_at: null });
});

it("rejects a notification with an invalid signature", async () => {
  const body = JSON.stringify({ event: { user_id: "42", reward: { id: "reward-1" } } });
  const res = await app.request(
    "/webhook/eventsub",
    {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": "msg-3",
        "Twitch-Eventsub-Message-Timestamp": new Date().toISOString(),
        "Twitch-Eventsub-Message-Signature": "sha256=wrong",
        "Twitch-Eventsub-Message-Type": "notification",
      },
    },
    env
  );
  expect(res.status).toBe(403);
});

it("ignores a notification for a different reward id", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
    event: { user_id: "99", user_login: "other", reward: { id: "some-other-reward" } },
  });
  const messageId = "msg-4";
  const timestamp = new Date().toISOString();
  const signature = await signBody(messageId, timestamp, body);

  const res = await app.request(
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
  expect(res.status).toBe(200);
  const pack = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("99").first();
  expect(pack).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:worker -- webhook`
Expected: FAIL with "Cannot find module '../../worker/routes/webhook'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/routes/webhook.ts
import { Hono } from "hono";
import type { Env } from "../types";
import { verifyEventSubSignature } from "../lib/eventsub";

const webhook = new Hono<{ Bindings: Env }>();

webhook.post("/eventsub", async (c) => {
  const body = await c.req.text();
  const messageId = c.req.header("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = c.req.header("Twitch-Eventsub-Message-Timestamp") ?? "";
  const signature = c.req.header("Twitch-Eventsub-Message-Signature") ?? "";
  const messageType = c.req.header("Twitch-Eventsub-Message-Type") ?? "";

  const valid = await verifyEventSubSignature({
    secret: c.env.TWITCH_EVENTSUB_SECRET,
    messageId,
    timestamp,
    body,
    signatureHeader: signature,
  });
  if (!valid) return c.json({ error: "Invalid signature" }, 403);

  const payload = JSON.parse(body) as {
    challenge?: string;
    event?: { user_id: string; user_login: string; user_name: string; reward: { id: string } };
  };

  if (messageType === "webhook_callback_verification") {
    return c.text(payload.challenge ?? "", 200);
  }

  if (messageType === "notification" && payload.event) {
    const { user_id, user_login, reward } = payload.event;
    if (reward.id !== c.env.TWITCH_REWARD_ID) return c.json({ ok: true }, 200);

    await c.env.DB.prepare(
      `INSERT INTO users (twitch_id, username) VALUES (?, ?)
       ON CONFLICT(twitch_id) DO UPDATE SET username = excluded.username`
    )
      .bind(user_id, user_login)
      .run();
    await c.env.DB.prepare("INSERT INTO packs (user_id) VALUES (?)").bind(user_id).run();
    return c.json({ ok: true }, 200);
  }

  return c.json({ ok: true }, 200);
});

export default webhook;
```

Wire it into the app:

```typescript
// worker/index.ts (add)
import webhook from "./routes/webhook";
// ...
app.route("/webhook", webhook);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:worker -- webhook`
Expected: PASS — 4 tests passed

- [ ] **Step 5: Commit**

```bash
git add worker/routes/webhook.ts worker/index.ts test/routes/webhook.test.ts
git commit -m "feat: add EventSub webhook receiver for pack redemptions"
```

---

### Task 8: Collection routes (list + open pack)

**Files:**
- Create: `worker/routes/collection.ts`
- Modify: `worker/index.ts`
- Test: `test/routes/collection.test.ts`

**Interfaces:**
- Consumes: `requireAuth` (Task 6), `pickRandomCards` (Task 5).
- Produces: Hono sub-app mounted at `/api/collection`, routes `GET /` and `POST /packs/:id/open`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/routes/collection.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM pack_cards");
  await env.DB.exec("DELETE FROM user_cards");
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
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "r1",
      "Rare Card",
      "rare",
      "/cards/r1.png"
    ),
  ]);
});

it("requires auth", async () => {
  const res = await app.request("/api/collection", {}, env);
  expect(res.status).toBe(401);
});

it("lists all catalog cards with owned quantities and pending packs", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)")
    .bind("1", "c1", 2)
    .run();
  await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?)").bind("1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/collection", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string; quantity: number }[]; pendingPacks: { id: number }[] }>();

  const c1 = json.cards.find((c) => c.id === "c1");
  const r1 = json.cards.find((c) => c.id === "r1");
  expect(c1?.quantity).toBe(2);
  expect(r1?.quantity).toBe(0);
  expect(json.pendingPacks).toHaveLength(1);
});

it("opens a pending pack and grants 5 cards", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string }[] }>();
  expect(json.cards).toHaveLength(5);

  const pack = await env.DB.prepare("SELECT opened_at FROM packs WHERE id = ?")
    .bind(packResult!.id)
    .first<{ opened_at: string | null }>();
  expect(pack?.opened_at).not.toBeNull();
});

it("rejects opening a pack that belongs to another user", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("2")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(404);
});

it("rejects opening an already-opened pack", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();
  const cookie = await sessionCookie("1", "viewer1");
  await app.request(`/api/collection/packs/${packResult!.id}/open`, { method: "POST", headers: { Cookie: cookie } }, env);

  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(409);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:worker -- collection`
Expected: FAIL with "Cannot find module '../../worker/routes/collection'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/routes/collection.ts
import { Hono } from "hono";
import type { Env, Rarity } from "../types";
import { requireAuth } from "../middleware/auth";
import { pickRandomCards } from "../lib/packs";

const collection = new Hono<{ Bindings: Env; Variables: { user: { twitchId: string; username: string } } }>();

collection.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const cards = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.rarity, c.image_path AS imagePath, COALESCE(uc.quantity, 0) AS quantity
     FROM cards c
     LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = ?
     ORDER BY c.id`
  )
    .bind(user.twitchId)
    .all();

  const pendingPacks = await c.env.DB.prepare(
    "SELECT id, created_at AS createdAt FROM packs WHERE user_id = ? AND opened_at IS NULL ORDER BY created_at"
  )
    .bind(user.twitchId)
    .all();

  return c.json({ cards: cards.results, pendingPacks: pendingPacks.results });
});

collection.post("/packs/:id/open", requireAuth, async (c) => {
  const user = c.get("user");
  const packId = Number(c.req.param("id"));

  const pack = await c.env.DB.prepare("SELECT id, user_id, opened_at FROM packs WHERE id = ?")
    .bind(packId)
    .first<{ id: number; user_id: string; opened_at: string | null }>();
  if (!pack || pack.user_id !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (pack.opened_at) return c.json({ error: "Pack already opened" }, 409);

  const catalog = await c.env.DB.prepare("SELECT id, rarity FROM cards").all<{ id: string; rarity: Rarity }>();
  if (!catalog.results || catalog.results.length === 0) {
    return c.json({ error: "Catalog is empty" }, 500);
  }

  const picked = pickRandomCards(catalog.results, 5);

  const statements = picked.map((card) =>
    c.env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packId, card.id)
  );
  for (const card of picked) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, 1)
         ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1`
      ).bind(user.twitchId, card.id)
    );
  }
  statements.push(c.env.DB.prepare("UPDATE packs SET opened_at = CURRENT_TIMESTAMP WHERE id = ?").bind(packId));
  await c.env.DB.batch(statements);

  const placeholders = picked.map(() => "?").join(",");
  const cardDetails = await c.env.DB.prepare(
    `SELECT id, name, rarity, image_path AS imagePath FROM cards WHERE id IN (${placeholders})`
  )
    .bind(...picked.map((card) => card.id))
    .all();

  return c.json({ cards: cardDetails.results });
});

export default collection;
```

Wire it into the app:

```typescript
// worker/index.ts (add)
import collection from "./routes/collection";
// ...
app.route("/api/collection", collection);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:worker -- collection`
Expected: PASS — 5 tests passed

- [ ] **Step 5: Commit**

```bash
git add worker/routes/collection.ts worker/index.ts test/routes/collection.test.ts
git commit -m "feat: add collection listing and pack opening endpoints"
```

---

### Task 9: Trade routes (browse + create offer)

**Files:**
- Create: `worker/routes/trade.ts`
- Modify: `worker/index.ts`
- Test: `test/routes/trade.test.ts`

**Interfaces:**
- Consumes: `requireAuth` (Task 6).
- Produces: Hono sub-app mounted at `/api/trade`, routes `GET /users/:username`, `POST /offers`, `GET /offers` (accept/decline/cancel added in Task 10).

- [ ] **Step 1: Write the failing test**

```typescript
// test/routes/trade.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM trade_items");
  await env.DB.exec("DELETE FROM trade_offers");
  await env.DB.exec("DELETE FROM user_cards");
  await env.DB.exec("DELETE FROM cards");
  await env.DB.exec("DELETE FROM users");

  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1"),
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "c1",
      "Common Card",
      "common",
      "/cards/c1.png"
    ),
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 3),
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("2", "c1", 1),
  ]);
});

it("looks up another user's public collection", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/trade/users/viewer2", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ username: string; cards: { id: string; quantity: number }[] }>();
  expect(json.username).toBe("viewer2");
  expect(json.cards.find((c) => c.id === "c1")?.quantity).toBe(1);
});

it("creates a pending trade offer", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [{ cardId: "c1", quantity: 1 }],
      }),
    },
    env
  );
  expect(res.status).toBe(201);

  const offer = await env.DB.prepare("SELECT from_user, to_user, status FROM trade_offers").first<{
    from_user: string;
    to_user: string;
    status: string;
  }>();
  expect(offer).toEqual({ from_user: "1", to_user: "2", status: "pending" });
});

it("rejects an offer for more cards than the sender owns", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 99 }],
        requestCards: [],
      }),
    },
    env
  );
  expect(res.status).toBe(409);
});

it("lists offers sent and received by the current user", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [{ cardId: "c1", quantity: 1 }],
      }),
    },
    env
  );

  const res = await app.request("/api/trade/offers", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ sent: unknown[]; received: unknown[] }>();
  expect(json.sent).toHaveLength(1);
  expect(json.received).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:worker -- trade`
Expected: FAIL with "Cannot find module '../../worker/routes/trade'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/routes/trade.ts
import { Hono } from "hono";
import type { Env } from "../types";
import { requireAuth } from "../middleware/auth";

interface TradeCardInput {
  cardId: string;
  quantity: number;
}

const trade = new Hono<{ Bindings: Env; Variables: { user: { twitchId: string; username: string } } }>();

trade.get("/users/:username", requireAuth, async (c) => {
  const username = c.req.param("username");
  const targetUser = await c.env.DB.prepare("SELECT twitch_id, username FROM users WHERE username = ?")
    .bind(username)
    .first<{ twitch_id: string; username: string }>();
  if (!targetUser) return c.json({ error: "Not found" }, 404);

  const cards = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.rarity, c.image_path AS imagePath, COALESCE(uc.quantity, 0) AS quantity
     FROM cards c
     LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = ?
     ORDER BY c.id`
  )
    .bind(targetUser.twitch_id)
    .all();

  return c.json({ username: targetUser.username, cards: cards.results });
});

async function ownedQuantity(env: Env, userId: string, cardId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind(userId, cardId)
    .first<{ quantity: number }>();
  return row?.quantity ?? 0;
}

trade.post("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    toUsername: string;
    offerCards: TradeCardInput[];
    requestCards: TradeCardInput[];
  }>();

  const toUser = await c.env.DB.prepare("SELECT twitch_id FROM users WHERE username = ?")
    .bind(body.toUsername)
    .first<{ twitch_id: string }>();
  if (!toUser) return c.json({ error: "Target user not found" }, 404);

  for (const item of body.offerCards) {
    const owned = await ownedQuantity(c.env, user.twitchId, item.cardId);
    if (owned < item.quantity) return c.json({ error: `You do not own enough of card ${item.cardId}` }, 409);
  }
  for (const item of body.requestCards) {
    const owned = await ownedQuantity(c.env, toUser.twitch_id, item.cardId);
    if (owned < item.quantity) return c.json({ error: `Target does not own enough of card ${item.cardId}` }, 409);
  }

  const offerResult = await c.env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user) VALUES (?, ?) RETURNING id"
  )
    .bind(user.twitchId, toUser.twitch_id)
    .first<{ id: number }>();
  const offerId = offerResult!.id;

  const statements = [
    ...body.offerCards.map((item) =>
      c.env.DB.prepare("INSERT INTO trade_items (offer_id, side, card_id, quantity) VALUES (?, 'from', ?, ?)").bind(
        offerId,
        item.cardId,
        item.quantity
      )
    ),
    ...body.requestCards.map((item) =>
      c.env.DB.prepare("INSERT INTO trade_items (offer_id, side, card_id, quantity) VALUES (?, 'to', ?, ?)").bind(
        offerId,
        item.cardId,
        item.quantity
      )
    ),
  ];
  if (statements.length > 0) await c.env.DB.batch(statements);

  return c.json({ id: offerId, status: "pending" }, 201);
});

trade.get("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  const sent = await c.env.DB.prepare(
    "SELECT id, to_user AS toUser, status FROM trade_offers WHERE from_user = ? ORDER BY created_at DESC"
  )
    .bind(user.twitchId)
    .all();
  const received = await c.env.DB.prepare(
    "SELECT id, from_user AS fromUser, status FROM trade_offers WHERE to_user = ? ORDER BY created_at DESC"
  )
    .bind(user.twitchId)
    .all();
  return c.json({ sent: sent.results, received: received.results });
});

export default trade;
```

Wire it into the app:

```typescript
// worker/index.ts (add)
import trade from "./routes/trade";
// ...
app.route("/api/trade", trade);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:worker -- trade`
Expected: PASS — 4 tests passed

- [ ] **Step 5: Commit**

```bash
git add worker/routes/trade.ts worker/index.ts test/routes/trade.test.ts
git commit -m "feat: add trade offer browsing and creation endpoints"
```

---

### Task 10: Trade accept/decline/cancel

**Files:**
- Modify: `worker/routes/trade.ts`
- Modify: `test/routes/trade.test.ts`

**Interfaces:**
- Adds routes `POST /offers/:id/accept`, `POST /offers/:id/decline`, `POST /offers/:id/cancel` to the existing `trade` sub-app from Task 9.

- [ ] **Step 1: Write the failing test**

Append to `test/routes/trade.test.ts`:

```typescript
it("accepts an offer and swaps card ownership atomically", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");

  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [{ cardId: "c1", quantity: 1 }],
      }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const acceptRes = await app.request(
    `/api/trade/offers/${offerId}/accept`,
    { method: "POST", headers: { Cookie: cookieTo } },
    env
  );
  expect(acceptRes.status).toBe(200);

  const offer = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string }>();
  expect(offer?.status).toBe("accepted");

  const fromQty = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  const toQty = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("2", "c1")
    .first<{ quantity: number }>();
  expect(fromQty?.quantity).toBe(3);
  expect(toQty?.quantity).toBe(1);
});

it("rejects accept from a user who is not the offer recipient", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const res = await app.request(
    `/api/trade/offers/${offerId}/accept`,
    { method: "POST", headers: { Cookie: cookieFrom } },
    env
  );
  expect(res.status).toBe(404);
});

it("declines an offer", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const res = await app.request(
    `/api/trade/offers/${offerId}/decline`,
    { method: "POST", headers: { Cookie: cookieTo } },
    env
  );
  expect(res.status).toBe(200);
  const offer = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string }>();
  expect(offer?.status).toBe("declined");
});

it("cancels an offer", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const res = await app.request(
    `/api/trade/offers/${offerId}/cancel`,
    { method: "POST", headers: { Cookie: cookieFrom } },
    env
  );
  expect(res.status).toBe(200);
  const offer = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string }>();
  expect(offer?.status).toBe("cancelled");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:worker -- trade`
Expected: FAIL — the 4 new tests fail with 404 (routes don't exist yet)

- [ ] **Step 3: Write minimal implementation**

Append to `worker/routes/trade.ts` (before `export default trade;`):

```typescript
interface TradeItemRow {
  side: "from" | "to";
  card_id: string;
  quantity: number;
}

trade.post("/offers/:id/accept", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT id, from_user, to_user, status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ id: number; from_user: string; to_user: string; status: string }>();
  if (!offer || offer.to_user !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (offer.status !== "pending") return c.json({ error: "Offer is not pending" }, 409);

  const items = await c.env.DB.prepare("SELECT side, card_id, quantity FROM trade_items WHERE offer_id = ?")
    .bind(offerId)
    .all<TradeItemRow>();

  for (const item of items.results) {
    const ownerId = item.side === "from" ? offer.from_user : offer.to_user;
    const owned = await ownedQuantity(c.env, ownerId, item.card_id);
    if (owned < item.quantity) {
      return c.json({ error: `Insufficient quantity for card ${item.card_id}` }, 409);
    }
  }

  const statements = [];
  for (const item of items.results) {
    const giver = item.side === "from" ? offer.from_user : offer.to_user;
    const receiver = item.side === "from" ? offer.to_user : offer.from_user;
    statements.push(
      c.env.DB.prepare("UPDATE user_cards SET quantity = quantity - ? WHERE user_id = ? AND card_id = ?").bind(
        item.quantity,
        giver,
        item.card_id
      )
    );
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)
         ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + ?`
      ).bind(receiver, item.card_id, item.quantity, item.quantity)
    );
  }
  statements.push(c.env.DB.prepare("UPDATE trade_offers SET status = 'accepted' WHERE id = ?").bind(offerId));
  await c.env.DB.batch(statements);

  return c.json({ status: "accepted" });
});

trade.post("/offers/:id/decline", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT to_user, status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ to_user: string; status: string }>();
  if (!offer || offer.to_user !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (offer.status !== "pending") return c.json({ error: "Offer is not pending" }, 409);

  await c.env.DB.prepare("UPDATE trade_offers SET status = 'declined' WHERE id = ?").bind(offerId).run();
  return c.json({ status: "declined" });
});

trade.post("/offers/:id/cancel", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT from_user, status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ from_user: string; status: string }>();
  if (!offer || offer.from_user !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (offer.status !== "pending") return c.json({ error: "Offer is not pending" }, 409);

  await c.env.DB.prepare("UPDATE trade_offers SET status = 'cancelled' WHERE id = ?").bind(offerId).run();
  return c.json({ status: "cancelled" });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:worker -- trade`
Expected: PASS — 8 tests passed (4 from Task 9 + 4 new)

- [ ] **Step 5: Commit**

```bash
git add worker/routes/trade.ts test/routes/trade.test.ts
git commit -m "feat: add trade offer accept, decline, and cancel endpoints"
```

---

### Task 11: Catalog CLI tool

**Files:**
- Create: `tools/catalog/build-catalog.ts`
- Create: `tools/catalog/build-catalog.test.ts`
- Create: `tools/catalog/cards.csv`

**Interfaces:**
- Produces (pure, testable functions): `parseCsv(content: string): CardRow[]`, `buildCatalog(rows: CardRow[], existingImageFiles: Set<string>): { catalog: CatalogEntry[]; seedSql: string }`.
- Produces (I/O entrypoint, not unit tested): `main()` — reads `tools/catalog/cards.csv` and `public/cards/`, writes `catalog.json` and `tools/catalog/seed-cards.sql`.
- `CatalogEntry`: `{ id: string; name: string; rarity: "common" | "rare" | "epic" | "legendary"; imagePath: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
// tools/catalog/build-catalog.test.ts
import { it, expect } from "vitest";
import { parseCsv, buildCatalog } from "./build-catalog";

it("parses CSV rows", () => {
  const csv = "id,name,rarity,image_filename\nc1,Common Card,common,c1.png\nr1,Rare Card,rare,r1.png\n";
  const rows = parseCsv(csv);
  expect(rows).toEqual([
    { id: "c1", name: "Common Card", rarity: "common", imageFilename: "c1.png" },
    { id: "r1", name: "Rare Card", rarity: "rare", imageFilename: "r1.png" },
  ]);
});

it("throws on an unknown rarity", () => {
  const csv = "id,name,rarity,image_filename\nc1,Common Card,mythic,c1.png\n";
  expect(() => parseCsv(csv)).toThrow(/rarity/i);
});

it("builds a catalog and seed SQL from valid rows", () => {
  const rows = [
    { id: "c1", name: "Common Card", rarity: "common" as const, imageFilename: "c1.png" },
    { id: "r1", name: "Rare Card", rarity: "rare" as const, imageFilename: "r1.png" },
  ];
  const { catalog, seedSql } = buildCatalog(rows, new Set(["c1.png", "r1.png"]));

  expect(catalog).toEqual([
    { id: "c1", name: "Common Card", rarity: "common", imagePath: "/cards/c1.png" },
    { id: "r1", name: "Rare Card", rarity: "rare", imagePath: "/cards/r1.png" },
  ]);
  expect(seedSql).toContain("INSERT OR REPLACE INTO cards");
  expect(seedSql).toContain("'c1'");
  expect(seedSql).toContain("'r1'");
});

it("throws when a referenced image file does not exist", () => {
  const rows = [{ id: "c1", name: "Common Card", rarity: "common" as const, imageFilename: "missing.png" }];
  expect(() => buildCatalog(rows, new Set(["c1.png"]))).toThrow(/missing\.png/);
});

it("throws on duplicate card ids", () => {
  const rows = [
    { id: "c1", name: "Common Card", rarity: "common" as const, imageFilename: "c1.png" },
    { id: "c1", name: "Duplicate", rarity: "rare" as const, imageFilename: "c1.png" },
  ];
  expect(() => buildCatalog(rows, new Set(["c1.png"]))).toThrow(/duplicate/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module './build-catalog'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// tools/catalog/build-catalog.ts
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

export type Rarity = "common" | "rare" | "epic" | "legendary";
const VALID_RARITIES: Rarity[] = ["common", "rare", "epic", "legendary"];

export interface CardRow {
  id: string;
  name: string;
  rarity: Rarity;
  imageFilename: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
}

export function parseCsv(content: string): CardRow[] {
  const lines = content.trim().split("\n").filter((line) => line.length > 0);
  const [, ...dataLines] = lines;
  return dataLines.map((line) => {
    const [id, name, rarity, imageFilename] = line.split(",").map((field) => field.trim());
    if (!VALID_RARITIES.includes(rarity as Rarity)) {
      throw new Error(`Invalid rarity "${rarity}" for card "${id}". Must be one of: ${VALID_RARITIES.join(", ")}`);
    }
    return { id, name, rarity: rarity as Rarity, imageFilename };
  });
}

export function buildCatalog(
  rows: CardRow[],
  existingImageFiles: Set<string>
): { catalog: CatalogEntry[]; seedSql: string } {
  const seenIds = new Set<string>();
  const catalog: CatalogEntry[] = [];

  for (const row of rows) {
    if (seenIds.has(row.id)) throw new Error(`Duplicate card id: ${row.id}`);
    seenIds.add(row.id);

    if (!existingImageFiles.has(row.imageFilename)) {
      throw new Error(`Image file not found in public/cards/: ${row.imageFilename}`);
    }

    catalog.push({ id: row.id, name: row.name, rarity: row.rarity, imagePath: `/cards/${row.imageFilename}` });
  }

  const values = catalog
    .map((card) => `('${card.id}', '${card.name.replace(/'/g, "''")}', '${card.rarity}', '${card.imagePath}')`)
    .join(",\n  ");
  const seedSql = `INSERT OR REPLACE INTO cards (id, name, rarity, image_path) VALUES\n  ${values};\n`;

  return { catalog, seedSql };
}

function main(): void {
  const csvPath = path.join(__dirname, "cards.csv");
  const imagesDir = path.join(__dirname, "..", "..", "public", "cards");
  const catalogOutPath = path.join(__dirname, "..", "..", "catalog.json");
  const seedOutPath = path.join(__dirname, "seed-cards.sql");

  const csvContent = readFileSync(csvPath, "utf-8");
  const rows = parseCsv(csvContent);

  const existingImageFiles = new Set(existsSync(imagesDir) ? readdirSync(imagesDir) : []);
  const { catalog, seedSql } = buildCatalog(rows, existingImageFiles);

  writeFileSync(catalogOutPath, JSON.stringify(catalog, null, 2));
  writeFileSync(seedOutPath, seedSql);

  console.log(`Wrote ${catalog.length} cards to ${catalogOutPath} and ${seedOutPath}`);
}

if (require.main === module) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 5 tests passed

- [ ] **Step 5: Create sample seed CSV and apply it locally**

`tools/catalog/cards.csv`:

```
id,name,rarity,image_filename
placeholder-1,Placeholder Común,common,placeholder-1.png
placeholder-2,Placeholder Rara,rare,placeholder-2.png
placeholder-3,Placeholder Épica,epic,placeholder-3.png
placeholder-4,Placeholder Legendaria,legendary,placeholder-4.png
```

Create 4 placeholder 1x1 PNG files at `public/cards/placeholder-1.png` through `placeholder-4.png` (the streamer will replace these with real artwork later — see spec's "fuera de alcance").

Run: `npm run catalog:build`
Expected: creates `catalog.json` and `tools/catalog/seed-cards.sql` at the project root without errors

Run: `npx wrangler d1 migrations apply twitch-cards-db --local` (creates the local D1 schema, if not already applied)
Run: `npx wrangler d1 execute twitch-cards-db --local --file=./tools/catalog/seed-cards.sql`
Expected: reports 4 rows written, no errors

- [ ] **Step 6: Commit**

```bash
git add tools/catalog/build-catalog.ts tools/catalog/build-catalog.test.ts tools/catalog/cards.csv public/cards/placeholder-1.png public/cards/placeholder-2.png public/cards/placeholder-3.png public/cards/placeholder-4.png
git commit -m "feat: add catalog CLI tool with CSV validation and D1 seed generation"
```

---

### Task 12: Frontend design system + login page

**Files:**
- Create: `src/style.css`
- Modify: `index.html`
- Create: `src/login.ts`

**Interfaces:**
- Produces: shared CSS classes (`.card`, `.btn`, `.badge`, `.container`) imported by `collection.ts`/`trade.ts` entries in Tasks 13/14.

- [ ] **Step 1: Create `src/style.css`**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --pink: #FF56B4;
  --blue: #00CCFF;
  --bg: #1E1E1E;
  --surface: #252525;
  --surface2: #2D2D2D;
  --border: rgba(255, 255, 255, 0.07);
  --text: #858585;
  --text-em: #F0F0F0;
  --muted: #9A9A9A;
  --dim: #555555;
}

html { background: #0A0A0A; font-size: 16px; }
@media (min-width: 700px) { html { font-size: 20px; } }

body {
  font-family: 'JetBrains Mono', monospace;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

a { color: inherit; text-decoration: none; }
img { display: block; max-width: 100%; }

h1, h2, h3 { font-family: 'Russo One', sans-serif; color: var(--text-em); }

.container {
  max-width: 860px;
  margin: 0 auto;
  padding: 0 1rem;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 1.15rem 1.4rem;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.card:hover {
  border-color: rgba(255, 86, 180, 0.35);
  box-shadow: 0 0 20px rgba(255, 86, 180, 0.15);
}
.card.unowned { opacity: 0.35; }

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1.25rem;
  border-radius: 100px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  font-size: 0.85rem;
  background: var(--surface2);
  color: var(--text);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.btn:hover {
  background: var(--surface);
  border-color: rgba(0, 204, 255, 0.30);
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.65rem;
  border-radius: 100px;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: rgba(255, 86, 180, 0.15);
  color: var(--pink);
  border: 1px solid rgba(255, 86, 180, 0.30);
}
.badge.rarity-rare { background: rgba(0, 204, 255, 0.15); color: var(--blue); border-color: rgba(0, 204, 255, 0.30); }
.badge.rarity-epic { background: rgba(255, 86, 180, 0.15); color: var(--pink); border-color: rgba(255, 86, 180, 0.30); }
.badge.rarity-legendary { background: rgba(255, 215, 0, 0.15); color: #FFD700; border-color: rgba(255, 215, 0, 0.40); }

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 1rem;
  margin-top: 1.5rem;
}

@keyframes card-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
.card-in { animation: card-in 0.3s ease both; }
```

- [ ] **Step 2: Replace `index.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Russo+One&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/src/style.css" />
    <title>Colección de Cartas</title>
  </head>
  <body>
    <div class="container" style="padding-top: 3rem; text-align: center;">
      <h1>Colección de Cartas</h1>
      <p style="margin-top: 0.5rem;">Canjea puntos de canal en Twitch para conseguir sobres.</p>
      <a class="btn" href="/api/auth/login" style="margin-top: 1.5rem;">Login con Twitch</a>
    </div>
    <script type="module" src="/src/login.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `src/login.ts`**

```typescript
// Landing page currently has no client-side behavior beyond the login link.
export {};
```

- [ ] **Step 4: Verify in the browser**

Run: `npm run dev`
Expected: dev server starts; visiting `http://localhost:5173/` shows the styled landing page with a "Login con Twitch" button

- [ ] **Step 5: Commit**

```bash
git add src/style.css index.html src/login.ts
git commit -m "feat: add brand design system and login landing page"
```

---

### Task 13: Frontend collection page

**Files:**
- Create: `src/api.ts`
- Create: `collection.html`
- Create: `src/collection.ts`

**Interfaces:**
- Produces: `getCollection(): Promise<CollectionResponse>`, `openPack(packId: number): Promise<{ cards: CardView[] }>` in `src/api.ts`, reused by `src/trade.ts` (Task 14) for the shared `request()` helper and `CardView` type.

- [ ] **Step 1: Create `src/api.ts`**

```typescript
const BASE = "/api";

export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface CardView {
  id: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
  quantity: number;
}

export interface PendingPack {
  id: number;
  createdAt: string;
}

export interface CollectionResponse {
  cards: CardView[];
  pendingPacks: PendingPack[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init });
  if (res.status === 401) {
    window.location.href = "/";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export function getCollection(): Promise<CollectionResponse> {
  return request("/collection");
}

export function openPack(packId: number): Promise<{ cards: CardView[] }> {
  return request(`/collection/packs/${packId}/open`, { method: "POST" });
}

export function getUserCollection(username: string): Promise<{ username: string; cards: CardView[] }> {
  return request(`/trade/users/${encodeURIComponent(username)}`);
}

export interface TradeOfferSummary {
  id: number;
  status: string;
  toUser?: string;
  fromUser?: string;
}

export function listOffers(): Promise<{ sent: TradeOfferSummary[]; received: TradeOfferSummary[] }> {
  return request("/trade/offers");
}

export function createOffer(input: {
  toUsername: string;
  offerCards: { cardId: string; quantity: number }[];
  requestCards: { cardId: string; quantity: number }[];
}): Promise<{ id: number; status: string }> {
  return request("/trade/offers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function acceptOffer(id: number): Promise<{ status: string }> {
  return request(`/trade/offers/${id}/accept`, { method: "POST" });
}

export function declineOffer(id: number): Promise<{ status: string }> {
  return request(`/trade/offers/${id}/decline`, { method: "POST" });
}

export function cancelOffer(id: number): Promise<{ status: string }> {
  return request(`/trade/offers/${id}/cancel`, { method: "POST" });
}
```

- [ ] **Step 2: Create `collection.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link
      href="https://fonts.googleapis.com/css2?family=Russo+One&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/src/style.css" />
    <title>Mi Colección</title>
  </head>
  <body>
    <div class="container" style="padding: 2rem 1rem;">
      <h1>Mi Colección</h1>
      <a class="btn" href="/trade.html" style="margin-top: 1rem;">Ir a Trading</a>

      <div id="pending-packs" style="margin-top: 2rem;"></div>
      <div id="card-grid" class="card-grid"></div>
    </div>
    <script type="module" src="/src/collection.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `src/collection.ts`**

```typescript
import { getCollection, openPack, type CardView, type PendingPack } from "./api";

function renderCard(card: CardView): string {
  const ownedClass = card.quantity > 0 ? "" : "unowned";
  return `
    <div class="card ${ownedClass} card-in">
      <img src="${card.imagePath}" alt="${card.name}" />
      <p style="margin-top: 0.5rem; color: var(--text-em);">${card.name}</p>
      <span class="badge rarity-${card.rarity}">${card.rarity}</span>
      ${card.quantity > 0 ? `<p style="margin-top: 0.25rem;">x${card.quantity}</p>` : ""}
    </div>
  `;
}

function renderPendingPacks(packs: PendingPack[], onOpen: (id: number) => void): void {
  const container = document.getElementById("pending-packs")!;
  if (packs.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `<h2>Sobres pendientes (${packs.length})</h2>`;
  for (const pack of packs) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.style.marginTop = "0.75rem";
    btn.textContent = `Abrir sobre #${pack.id}`;
    btn.addEventListener("click", () => onOpen(pack.id));
    container.appendChild(btn);
  }
}

async function revealPack(cards: CardView[]): Promise<void> {
  const grid = document.getElementById("card-grid")!;
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; gap: 1rem; z-index: 10;";
  document.body.appendChild(overlay);

  for (const card of cards) {
    const el = document.createElement("div");
    el.className = "card card-in";
    el.innerHTML = `<img src="${card.imagePath}" alt="${card.name}" /><p style="color: var(--text-em);">${card.name}</p><span class="badge rarity-${card.rarity}">${card.rarity}</span>`;
    overlay.appendChild(el);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  overlay.addEventListener("click", () => overlay.remove());
  grid.dispatchEvent(new Event("reload-collection"));
}

async function load(): Promise<void> {
  const data = await getCollection();
  const grid = document.getElementById("card-grid")!;
  grid.innerHTML = data.cards.map(renderCard).join("");

  renderPendingPacks(data.pendingPacks, async (packId) => {
    const result = await openPack(packId);
    await revealPack(result.cards);
    await load();
  });
}

load();
```

- [ ] **Step 4: Verify in the browser**

Run: `npm run dev`, log in via `/api/auth/login` with a Twitch test account, navigate to `/collection.html`
Expected: page shows all catalog cards (owned ones highlighted with quantity, unowned ones dimmed), pending packs listed with an "Abrir" button that reveals 5 cards one at a time and refreshes the grid

- [ ] **Step 5: Commit**

```bash
git add src/api.ts collection.html src/collection.ts
git commit -m "feat: add collection view with pack opening animation"
```

---

### Task 14: Frontend trade page

**Files:**
- Create: `trade.html`
- Create: `src/trade.ts`

**Interfaces:**
- Consumes: `getCollection`, `getUserCollection`, `listOffers`, `createOffer`, `acceptOffer`, `declineOffer`, `cancelOffer` from `src/api.ts` (Task 13).

- [ ] **Step 1: Create `trade.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link
      href="https://fonts.googleapis.com/css2?family=Russo+One&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/src/style.css" />
    <title>Trading</title>
  </head>
  <body>
    <div class="container" style="padding: 2rem 1rem;">
      <h1>Trading</h1>
      <a class="btn" href="/collection.html" style="margin-top: 1rem;">Volver a Colección</a>

      <div style="margin-top: 2rem;">
        <input class="input" id="search-username" placeholder="Buscar username de Twitch" />
        <button class="btn" id="search-btn">Buscar</button>
      </div>

      <div id="offer-builder" style="display: none; margin-top: 1.5rem;">
        <h2>Tú ofreces</h2>
        <div id="my-cards" class="card-grid"></div>
        <h2 style="margin-top: 1.5rem;">Tú pides</h2>
        <div id="target-collection" class="card-grid"></div>
        <button class="btn" id="send-offer-btn" style="margin-top: 1.5rem;">Enviar oferta</button>
      </div>

      <div style="margin-top: 2rem;">
        <h2>Ofertas</h2>
        <div id="offers-list"></div>
      </div>
    </div>
    <script type="module" src="/src/trade.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/trade.ts`**

```typescript
import {
  getCollection,
  getUserCollection,
  listOffers,
  createOffer,
  acceptOffer,
  declineOffer,
  cancelOffer,
  type CardView,
} from "./api";

let currentTargetUsername = "";

function renderSelectableCard(card: CardView, inputClass: string): string {
  if (card.quantity === 0) return "";
  return `
    <div class="card card-in">
      <img src="${card.imagePath}" alt="${card.name}" />
      <p style="color: var(--text-em);">${card.name} (tienes ${card.quantity})</p>
      <span class="badge rarity-${card.rarity}">${card.rarity}</span>
      <input
        type="number"
        class="input ${inputClass}"
        data-card-id="${card.id}"
        min="0"
        max="${card.quantity}"
        value="0"
        style="margin-top: 0.5rem; width: 100%;"
      />
    </div>
  `;
}

function collectQuantities(containerId: string, inputClass: string): { cardId: string; quantity: number }[] {
  const container = document.getElementById(containerId)!;
  const inputs = container.querySelectorAll<HTMLInputElement>(`.${inputClass}`);
  const result: { cardId: string; quantity: number }[] = [];
  inputs.forEach((input) => {
    const quantity = Number(input.value);
    if (quantity > 0) result.push({ cardId: input.dataset.cardId!, quantity });
  });
  return result;
}

async function searchUser(): Promise<void> {
  const input = document.getElementById("search-username") as HTMLInputElement;
  currentTargetUsername = input.value.trim();
  if (!currentTargetUsername) return;

  const [myCollection, targetCollection] = await Promise.all([
    getCollection(),
    getUserCollection(currentTargetUsername),
  ]);

  document.getElementById("my-cards")!.innerHTML = myCollection.cards
    .map((card) => renderSelectableCard(card, "offer-qty"))
    .join("");
  document.getElementById("target-collection")!.innerHTML = targetCollection.cards
    .map((card) => renderSelectableCard(card, "request-qty"))
    .join("");
  document.getElementById("offer-builder")!.style.display = "block";
}

async function sendOffer(): Promise<void> {
  if (!currentTargetUsername) return;
  const offerCards = collectQuantities("my-cards", "offer-qty");
  const requestCards = collectQuantities("target-collection", "request-qty");
  if (offerCards.length === 0 && requestCards.length === 0) return;

  await createOffer({ toUsername: currentTargetUsername, offerCards, requestCards });
  document.getElementById("offer-builder")!.style.display = "none";
  await loadOffers();
}

function renderOffer(offer: { id: number; status: string; toUser?: string; fromUser?: string }, kind: "sent" | "received"): string {
  const label = kind === "sent" ? `Para: ${offer.toUser}` : `De: ${offer.fromUser}`;
  const actions =
    kind === "received" && offer.status === "pending"
      ? `<button class="btn accept-btn" data-id="${offer.id}">Aceptar</button>
         <button class="btn decline-btn" data-id="${offer.id}">Rechazar</button>`
      : kind === "sent" && offer.status === "pending"
        ? `<button class="btn cancel-btn" data-id="${offer.id}">Cancelar</button>`
        : "";
  return `<div class="card" style="margin-top: 0.75rem;">${label} — <span class="badge">${offer.status}</span><div style="margin-top: 0.5rem;">${actions}</div></div>`;
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

document.getElementById("search-btn")!.addEventListener("click", searchUser);
document.getElementById("send-offer-btn")!.addEventListener("click", sendOffer);
loadOffers();
```

- [ ] **Step 3: Verify in the browser**

Run: `npm run dev`, log in as two different Twitch test accounts (two browser profiles), search one for the other on `/trade.html`
Expected: search shows your own owned cards (with quantity inputs) and the target's owned cards (with quantity inputs); setting quantities and clicking "Enviar oferta" creates a pending offer visible under "Enviadas"; the other account sees it under "Recibidas" with Aceptar/Rechazar buttons that update status live

- [ ] **Step 4: Commit**

```bash
git add trade.html src/trade.ts
git commit -m "feat: add trade page with user search and offer management"
```

---

### Task 15: Wire remaining routes into the app entrypoint and add setup docs

**Files:**
- Modify: `worker/index.ts` (confirm all sub-apps mounted — auth, webhook, collection, trade)
- Create: `README.md`

**Interfaces:** none new — this task verifies the full route tree and documents operational setup.

- [ ] **Step 1: Confirm `worker/index.ts` mounts every route**

```typescript
// worker/index.ts
import { Hono } from "hono";
import type { Env } from "./types";
import auth from "./routes/auth";
import webhook from "./routes/webhook";
import collection from "./routes/collection";
import trade from "./routes/trade";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", auth);
app.route("/webhook", webhook);
app.route("/api/collection", collection);
app.route("/api/trade", trade);

export default app;
```

- [ ] **Step 2: Run the full test suite**

Run: `npm run test:worker && npm test`
Expected: all suites PASS (health, jwt, twitch, eventsub, packs, auth, webhook, collection, trade, build-catalog)

- [ ] **Step 3: Create `README.md`**

```markdown
# Colección de Cartas Twitch

## Setup

1. `npm install`
2. Create a D1 database: `npx wrangler d1 create twitch-cards-db`, paste the returned `database_id` into `wrangler.jsonc`.
3. `npx wrangler d1 migrations apply twitch-cards-db --local` (and `--remote` after first deploy) — use the D1 database name from `wrangler.jsonc` (`twitch-cards-db`), not the Worker's project name.
4. Copy `.dev.vars.example` to `.dev.vars` and fill in Twitch app credentials (create the app at https://dev.twitch.tv/console/apps) and a random `JWT_SECRET`/`TWITCH_EVENTSUB_SECRET`.
5. Design card artwork, drop PNGs into `public/cards/`, list them in `tools/catalog/cards.csv`, then run `npm run catalog:build` and apply `tools/catalog/seed-cards.sql` with `wrangler d1 execute`.
6. `npm run dev` to develop locally.

## Deploy

1. `npm run build`
2. `npx wrangler deploy`
3. Update the Twitch app's OAuth redirect URLs to the deployed domain.
4. Log in once as the broadcaster via `/api/auth/broadcaster-login` to register the EventSub subscription (requires the deployed HTTPS URL — Twitch cannot call back to localhost).

## Testing

- `npm run test:worker` — Workers-runtime tests (D1, routes)
- `npm test` — plain Node tests (catalog CLI tool)
```

- [ ] **Step 4: Commit**

```bash
git add worker/index.ts README.md
git commit -m "docs: add setup and deploy instructions"
```

---

## Self-Review Notes

- **Spec coverage:** auth (Task 6) ✓, EventSub redemption → pending pack (Task 7) ✓, on-demand pack opening with weighted RNG (Tasks 5, 8) ✓, duplicates stacking as quantity (Task 8) ✓, trading create/accept/decline/cancel (Tasks 9-10) ✓, catalog CLI tool (Task 11) ✓, brand design system + 3 frontend views (Tasks 12-14) ✓, D1-only/no-KV/no-DO stack (Task 1) ✓.
- **Deviation from spec worth flagging explicitly:** the spec's Auth section only described a single viewer OAuth flow. Registering the EventSub subscription for `channel.channel_points_custom_reward_redemption.add` requires a **broadcaster** user token with `channel:read:redemptions` scope — a plain app token isn't sufficient. Task 6 adds a second, broadcaster-only OAuth flow (`/broadcaster-login`, `/broadcaster-callback`) and a `broadcaster_credentials` table for this, gated by matching `TWITCH_BROADCASTER_ID`. This doesn't change any user-facing behavior described in the spec — it's the mechanism needed to make the spec's EventSub flow actually work.
- **Type consistency:** `CardView`/`Rarity` types are defined once in `src/api.ts` (frontend) and once in `worker/types.ts` (backend) — verified field names (`imagePath`, `quantity`, `rarity`) match between the collection/trade route JSON responses and the frontend consumers across Tasks 8, 9, 13, 14.
- **Fixed during self-review:** Task 14's original trade offer builder was a stub that always sent an empty offer. Replaced with a real quantity-input picker over both the user's own collection (`getCollection`) and the target's collection (`getUserCollection`), wired to `createOffer` end-to-end.
