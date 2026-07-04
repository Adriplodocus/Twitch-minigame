# Sobres automáticos por bits/subs/gift subs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** conceder sobres de apoyo (`tier = 'apoyo'`) automáticamente vía Twitch EventSub cuando un viewer anima bits (200 = 1 sobre, acumulado), se suscribe (incluye renovaciones), o regala suscripciones — sin intervención manual del admin.

**Architecture:** se generaliza el registro de subscripciones EventSub (`worker/lib/twitch.ts` + `worker/routes/auth.ts`) de 1 tipo fijo a 5, y se reescribe el despachador del webhook (`worker/routes/webhook.ts`) para ramificar por `subscription.type` en vez de asumir siempre canje de puntos. Se añade una columna `users.bits_balance` para acumular bits entre eventos de cheer.

**Tech Stack:** Hono + Cloudflare Workers + D1 (SQLite), tests con `@cloudflare/vitest-pool-workers` (Miniflare) para todo lo que toca `c.env.DB`, Vitest plano (Node) para `src/admin.ts`.

## Global Constraints

- 200 bits acumulados (no por evento individual) = 1 sobre; el resto se guarda entre eventos.
- 1 sobre por suscripción nueva Y por cada renovación mensual (no solo la primera vez).
- 1 sobre por cada suscripción regalada (el gifter recibe `total` sobres, no el receptor).
- Todos los sobres de este spec usan `tier = 'apoyo'`.
- Ignorar eventos de cheer/gift anónimos o sin `user_id` — no hay a quién asignar el sobre.
- No romper el flujo existente de canje de puntos de canal (`channel.channel_points_custom_reward_redemption.add`) — sus tests actuales deben seguir pasando sin modificarlos.
- Spec completo: `docs/superpowers/specs/2026-07-04-eventsub-support-packs-design.md`.

---

### Task 1: Migraciones — ampliar `packs.source` y añadir `users.bits_balance`

**Files:**
- Create: `migrations/0013_expand_pack_source.sql`
- Create: `migrations/0014_user_bits_balance.sql`

**Interfaces:**
- Consumes: nada (solo esquema).
- Produces: `packs.source` acepta ahora `'reward' | 'admin' | 'bits' | 'sub' | 'gift_sub'`; `users.bits_balance INTEGER NOT NULL DEFAULT 0`. Las tareas 2-4 dependen de que estas columnas/valores existan.

- [ ] **Step 1: Crear la migración que reconstruye `packs` con el CHECK ampliado**

`migrations/0013_expand_pack_source.sql`:

```sql
CREATE TABLE packs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  opened_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'reward' CHECK (source IN ('reward', 'admin', 'bits', 'sub', 'gift_sub')),
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

- [ ] **Step 2: Crear la migración de `bits_balance`**

`migrations/0014_user_bits_balance.sql`:

```sql
ALTER TABLE users ADD COLUMN bits_balance INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Ejecutar la suite de worker completa como regresión**

Run: `npm run test:worker`
Expected: PASS — `test/apply-migrations.ts` aplica automáticamente ambas migraciones nuevas antes de cada test; si el SQL tuviera un error de sintaxis o el rebuild rompiera una referencia, esta suite entera fallaría en el setup. Que todos los tests existentes sigan en verde confirma que el esquema quedó bien.

- [ ] **Step 4: Commit**

```bash
git add migrations/0013_expand_pack_source.sql migrations/0014_user_bits_balance.sql
git commit -m "feat: widen pack source values, add users.bits_balance"
```

---

### Task 2: `worker/lib/twitch.ts` — generalizar `createEventSubSubscription`

**Files:**
- Modify: `worker/lib/twitch.ts:64-90`
- Test: `test/lib/twitch.test.ts:54-74`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `createEventSubSubscription(opts: { accessToken: string; clientId: string; type: string; version: string; condition: Record<string, string>; callbackUrl: string; secret: string }, fetchImpl?: typeof fetch): Promise<void>`. Task 3 llama a esta función 5 veces con distintos `type`/`condition`.

- [ ] **Step 1: Reescribir el test existente para el nuevo signature**

Reemplaza en `test/lib/twitch.test.ts` el test `"creates an EventSub subscription"` (líneas 54-74) por:

```ts
it("creates an EventSub subscription", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 202 }));
  await createEventSubSubscription(
    {
      accessToken: "at",
      clientId: "abc",
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: "99", reward_id: "reward-1" },
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

it("treats a 409 (already subscribed) as success", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "Conflict" }), { status: 409 }));
  await expect(
    createEventSubSubscription(
      {
        accessToken: "at",
        clientId: "abc",
        type: "channel.cheer",
        version: "1",
        condition: { broadcaster_user_id: "99" },
        callbackUrl: "https://example.com/webhook/eventsub",
        secret: "whsecret",
      },
      fetchImpl as unknown as typeof fetch
    )
  ).resolves.toBeUndefined();
});

it("throws on a non-409 failure", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
  await expect(
    createEventSubSubscription(
      {
        accessToken: "at",
        clientId: "abc",
        type: "channel.cheer",
        version: "1",
        condition: { broadcaster_user_id: "99" },
        callbackUrl: "https://example.com/webhook/eventsub",
        secret: "whsecret",
      },
      fetchImpl as unknown as typeof fetch
    )
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Ejecutar los tests y confirmar que fallan**

Run: `npx vitest run test/lib/twitch.test.ts`
Expected: FAIL — el primer test falla porque `createEventSubSubscription` todavía espera `broadcasterId`/`rewardId` (TypeScript) y el 409 no se tolera aún.

- [ ] **Step 3: Reescribir la implementación**

Reemplaza en `worker/lib/twitch.ts` (líneas 64-90):

```ts
export async function createEventSubSubscription(
  opts: {
    accessToken: string;
    clientId: string;
    type: string;
    version: string;
    condition: Record<string, string>;
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
      type: opts.type,
      version: opts.version,
      condition: opts.condition,
      transport: { method: "webhook", callback: opts.callbackUrl, secret: opts.secret },
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`EventSub subscription creation failed (${opts.type}): ${res.status}`);
  }
}
```

- [ ] **Step 4: Ejecutar los tests y confirmar que pasan**

Run: `npx vitest run test/lib/twitch.test.ts`
Expected: PASS (todos los tests del archivo, incluidos los 2 nuevos)

- [ ] **Step 5: Commit**

```bash
git add worker/lib/twitch.ts test/lib/twitch.test.ts
git commit -m "refactor: generalize createEventSubSubscription to any type/condition"
```

---

### Task 3: `worker/routes/auth.ts` — registrar las 5 subscripciones con scopes ampliados

**Files:**
- Modify: `worker/routes/auth.ts:88-140`
- Modify: `README.md:17`
- Test: `test/routes/auth.test.ts:94-118`

**Interfaces:**
- Consumes: `createEventSubSubscription` de la Task 2 (`{ accessToken, clientId, type, version, condition, callbackUrl, secret }`).
- Produces: nada consumido por tasks posteriores — es el final de la cadena de registro.

- [ ] **Step 1: Actualizar el test de broadcaster-callback**

Reemplaza en `test/routes/auth.test.ts` el test `"creates an EventSub subscription with an app access token on a valid broadcaster callback"` (líneas 94-118) por:

```ts
it("registers all 5 EventSub subscriptions with an app access token on a valid broadcaster callback", async () => {
  vi.spyOn(twitch, "exchangeCodeForToken").mockResolvedValue({
    accessToken: "broadcaster-user-token",
    refreshToken: "rt",
    expiresIn: 14400,
  });
  vi.spyOn(twitch, "getTwitchUser").mockResolvedValue({
    id: env.TWITCH_BROADCASTER_ID,
    login: "mrklypp",
    profileImageUrl: "https://img",
  });
  vi.spyOn(twitch, "getAppAccessToken").mockResolvedValue("app-token");
  const createSpy = vi.spyOn(twitch, "createEventSubSubscription").mockResolvedValue(undefined);

  const res = await app.request(
    "/api/auth/broadcaster-callback?code=abc&state=expected",
    { headers: { Cookie: "broadcaster_oauth_state=expected" } },
    env
  );

  expect(res.status).toBe(200);
  expect(createSpy).toHaveBeenCalledTimes(5);
  const types = createSpy.mock.calls.map((call) => call[0].type);
  expect(types).toEqual([
    "channel.channel_points_custom_reward_redemption.add",
    "channel.cheer",
    "channel.subscribe",
    "channel.subscription.message",
    "channel.subscription.gift",
  ]);
  expect(createSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      accessToken: "app-token",
      type: "channel.channel_points_custom_reward_redemption.add",
      condition: { broadcaster_user_id: env.TWITCH_BROADCASTER_ID, reward_id: env.TWITCH_REWARD_ID },
    })
  );
  expect(createSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "channel.cheer",
      condition: { broadcaster_user_id: env.TWITCH_BROADCASTER_ID },
    })
  );

  vi.restoreAllMocks();
});

it("requests the extended scopes on broadcaster-login", async () => {
  const res = await app.request("/api/auth/broadcaster-login", { redirect: "manual" }, env);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location") ?? "");
  const scopes = (location.searchParams.get("scope") ?? "").split(" ");
  expect(scopes).toEqual(
    expect.arrayContaining(["channel:read:redemptions", "bits:read", "channel:read:subscriptions"])
  );
});
```

- [ ] **Step 2: Ejecutar los tests y confirmar que fallan**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/auth.test.ts`
Expected: FAIL — `createSpy` solo se llama 1 vez todavía, y el scope de login no incluye `bits:read`/`channel:read:subscriptions`.

- [ ] **Step 3: Ampliar los scopes de `broadcaster-login`**

En `worker/routes/auth.ts`, dentro de `auth.get("/broadcaster-login", ...)`, cambia:

```ts
scopes: ["channel:read:redemptions"],
```

por:

```ts
scopes: ["channel:read:redemptions", "bits:read", "channel:read:subscriptions"],
```

- [ ] **Step 4: Registrar las 5 subscripciones en `broadcaster-callback`**

Reemplaza el bloque de `await twitch.createEventSubSubscription({...})` (líneas ~129-136) por:

```ts
const callbackUrl = new URL("/webhook/eventsub", c.req.url).toString();
const broadcasterId = c.env.TWITCH_BROADCASTER_ID;
const subscriptions: { type: string; version: string; condition: Record<string, string> }[] = [
  {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    condition: { broadcaster_user_id: broadcasterId, reward_id: c.env.TWITCH_REWARD_ID },
  },
  { type: "channel.cheer", version: "1", condition: { broadcaster_user_id: broadcasterId } },
  { type: "channel.subscribe", version: "1", condition: { broadcaster_user_id: broadcasterId } },
  { type: "channel.subscription.message", version: "1", condition: { broadcaster_user_id: broadcasterId } },
  { type: "channel.subscription.gift", version: "1", condition: { broadcaster_user_id: broadcasterId } },
];
for (const subscription of subscriptions) {
  await twitch.createEventSubSubscription({
    accessToken: appAccessToken,
    clientId: c.env.TWITCH_CLIENT_ID,
    callbackUrl,
    secret: c.env.TWITCH_EVENTSUB_SECRET,
    ...subscription,
  });
}
```

- [ ] **Step 5: Ejecutar los tests y confirmar que pasan**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/auth.test.ts`
Expected: PASS

- [ ] **Step 6: Actualizar el README con la nota operativa de re-login**

En `README.md`, sustituye la línea 17:

```
4. Log in once as the broadcaster via `/api/auth/broadcaster-login` to register the EventSub subscription (requires the deployed HTTPS URL — Twitch cannot call back to localhost).
```

por:

```
4. Log in once as the broadcaster via `/api/auth/broadcaster-login` to register the EventSub subscriptions (channel points, bits, subs, gift subs) — requires the deployed HTTPS URL (Twitch cannot call back to localhost). If the broadcaster already logged in before scopes changed, repeat this step to re-authorize with the new scopes.
```

- [ ] **Step 7: Commit**

```bash
git add worker/routes/auth.ts test/routes/auth.test.ts README.md
git commit -m "feat: register bits/sub/gift-sub EventSub subscriptions"
```

---

### Task 4: `worker/routes/webhook.ts` — despachar por tipo de evento y conceder sobres de apoyo

**Files:**
- Modify: `worker/routes/webhook.ts` (reescritura completa)
- Test: `test/routes/webhook.test.ts` (añadir casos nuevos, no tocar los existentes)

**Interfaces:**
- Consumes: nada de tasks anteriores en tiempo de ejecución (usa `PackTier` de `worker/lib/packs.ts`, ya existente).
- Produces: nada consumido por otras tasks — es el punto final del flujo de concesión automática.

- [ ] **Step 1: Añadir los tests nuevos a `test/routes/webhook.test.ts`**

Añade estos `it(...)` al final del archivo (antes del cierre, reutilizando el helper `signBody` ya definido arriba):

```ts
it("accumulates bits below the threshold without granting a pack", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.cheer" },
    event: { user_id: "42", user_login: "mrklypp", bits: 150, is_anonymous: false },
  });
  const messageId = "msg-cheer-1";
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
  const pack = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("42").first();
  expect(pack).toBeNull();
  const user = await env.DB.prepare("SELECT bits_balance FROM users WHERE twitch_id = ?")
    .bind("42")
    .first<{ bits_balance: number }>();
  expect(user?.bits_balance).toBe(150);
});

it("grants a support pack once accumulated bits cross 200 and keeps the remainder", async () => {
  await env.DB.prepare(`INSERT INTO users (twitch_id, username, bits_balance) VALUES (?, ?, ?)`)
    .bind("42", "mrklypp", 150)
    .run();

  const body = JSON.stringify({
    subscription: { type: "channel.cheer" },
    event: { user_id: "42", user_login: "mrklypp", bits: 100, is_anonymous: false },
  });
  const messageId = "msg-cheer-2";
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

  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("42")
    .all<{ source: string; tier: string }>();
  expect(packs.results).toEqual([{ source: "bits", tier: "apoyo" }]);
  const user = await env.DB.prepare("SELECT bits_balance FROM users WHERE twitch_id = ?")
    .bind("42")
    .first<{ bits_balance: number }>();
  expect(user?.bits_balance).toBe(50);
});

it("grants multiple packs when a single cheer crosses the threshold more than once", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.cheer" },
    event: { user_id: "42", user_login: "mrklypp", bits: 450, is_anonymous: false },
  });
  const messageId = "msg-cheer-3";
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

  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("42")
    .all<{ source: string; tier: string }>();
  expect(packs.results).toHaveLength(2);
  packs.results!.forEach((p) => expect(p).toEqual({ source: "bits", tier: "apoyo" }));
  const user = await env.DB.prepare("SELECT bits_balance FROM users WHERE twitch_id = ?")
    .bind("42")
    .first<{ bits_balance: number }>();
  expect(user?.bits_balance).toBe(50);
});

it("ignores an anonymous cheer", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.cheer" },
    event: { user_id: "42", user_login: "mrklypp", bits: 500, is_anonymous: true },
  });
  const messageId = "msg-cheer-4";
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
  const user = await env.DB.prepare("SELECT * FROM users WHERE twitch_id = ?").bind("42").first();
  expect(user).toBeNull();
});

it("grants a support pack on a new (non-gift) subscription", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.subscribe" },
    event: { user_id: "42", user_login: "mrklypp", is_gift: false },
  });
  const messageId = "msg-sub-1";
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

  const pack = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("42")
    .first<{ source: string; tier: string }>();
  expect(pack).toEqual({ source: "sub", tier: "apoyo" });
});

it("does not grant a pack to the recipient of a gifted subscription", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.subscribe" },
    event: { user_id: "77", user_login: "recipient", is_gift: true },
  });
  const messageId = "msg-sub-2";
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

  const pack = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("77").first();
  expect(pack).toBeNull();
});

it("grants a support pack on a subscription renewal message", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.subscription.message" },
    event: { user_id: "42", user_login: "mrklypp", cumulative_months: 3 },
  });
  const messageId = "msg-resub-1";
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

  const pack = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("42")
    .first<{ source: string; tier: string }>();
  expect(pack).toEqual({ source: "sub", tier: "apoyo" });
});

it("grants total packs to the gifter on a subscription gift event", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.subscription.gift" },
    event: { user_id: "55", user_login: "generous", total: 3, is_anonymous: false },
  });
  const messageId = "msg-gift-1";
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

  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("55")
    .all<{ source: string; tier: string }>();
  expect(packs.results).toHaveLength(3);
  packs.results!.forEach((p) => expect(p).toEqual({ source: "gift_sub", tier: "apoyo" }));
});

it("ignores an anonymous subscription gift", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.subscription.gift" },
    event: { total: 5, is_anonymous: true },
  });
  const messageId = "msg-gift-2";
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
  const packs = await env.DB.prepare("SELECT * FROM packs").all();
  expect(packs.results).toHaveLength(0);
});
```

- [ ] **Step 2: Ejecutar los tests y confirmar que fallan**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/webhook.test.ts`
Expected: FAIL — el webhook actual ignora `subscription.type` y solo entiende el shape de canje de puntos (`event.reward.id`), así que ninguno de los casos nuevos concede sobres ni actualiza `bits_balance`.

- [ ] **Step 3: Reescribir `worker/routes/webhook.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "../types";
import type { PackTier } from "../lib/packs";
import { verifyEventSubSignature } from "../lib/eventsub";

const webhook = new Hono<{ Bindings: Env }>();

const BITS_PER_PACK = 200;

async function upsertUser(db: D1Database, userId: string, username: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (twitch_id, username) VALUES (?, ?)
       ON CONFLICT(twitch_id) DO UPDATE SET username = excluded.username`
    )
    .bind(userId, username)
    .run();
}

async function grantPacks(
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

async function addBitsAndGetPackCount(db: D1Database, userId: string, bits: number): Promise<number> {
  const row = await db
    .prepare("SELECT bits_balance FROM users WHERE twitch_id = ?")
    .bind(userId)
    .first<{ bits_balance: number }>();
  const balance = (row?.bits_balance ?? 0) + bits;
  await db
    .prepare("UPDATE users SET bits_balance = ? WHERE twitch_id = ?")
    .bind(balance % BITS_PER_PACK, userId)
    .run();
  return Math.floor(balance / BITS_PER_PACK);
}

interface RewardRedemptionEvent {
  user_id: string;
  user_login: string;
  reward: { id: string };
}
interface CheerEvent {
  user_id?: string;
  user_login?: string;
  bits: number;
  is_anonymous: boolean;
}
interface SubscribeEvent {
  user_id: string;
  user_login: string;
  is_gift: boolean;
}
interface SubscriptionMessageEvent {
  user_id: string;
  user_login: string;
}
interface SubscriptionGiftEvent {
  user_id?: string;
  user_login?: string;
  total: number;
  is_anonymous: boolean;
}

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
    subscription?: { type: string };
    event?: Record<string, unknown>;
  };

  if (messageType === "webhook_callback_verification") {
    return c.text(payload.challenge ?? "", 200);
  }

  if (messageType !== "notification" || !payload.event) {
    return c.json({ ok: true }, 200);
  }

  const subscriptionType = payload.subscription?.type ?? "";

  switch (subscriptionType) {
    case "channel.channel_points_custom_reward_redemption.add": {
      const event = payload.event as unknown as RewardRedemptionEvent;
      if (event.reward.id !== c.env.TWITCH_REWARD_ID) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      await grantPacks(c.env.DB, event.user_id, 1, "reward", "gratis");
      break;
    }
    case "channel.cheer": {
      const event = payload.event as unknown as CheerEvent;
      if (event.is_anonymous || !event.user_id) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login ?? event.user_id);
      const packs = await addBitsAndGetPackCount(c.env.DB, event.user_id, event.bits);
      await grantPacks(c.env.DB, event.user_id, packs, "bits", "apoyo");
      break;
    }
    case "channel.subscribe": {
      const event = payload.event as unknown as SubscribeEvent;
      if (event.is_gift) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      await grantPacks(c.env.DB, event.user_id, 1, "sub", "apoyo");
      break;
    }
    case "channel.subscription.message": {
      const event = payload.event as unknown as SubscriptionMessageEvent;
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      await grantPacks(c.env.DB, event.user_id, 1, "sub", "apoyo");
      break;
    }
    case "channel.subscription.gift": {
      const event = payload.event as unknown as SubscriptionGiftEvent;
      if (event.is_anonymous || !event.user_id) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login ?? event.user_id);
      await grantPacks(c.env.DB, event.user_id, event.total, "gift_sub", "apoyo");
      break;
    }
  }

  return c.json({ ok: true }, 200);
});

export default webhook;
```

- [ ] **Step 4: Ejecutar toda la suite de worker y confirmar que pasa**

Run: `npm run test:worker`
Expected: PASS — todos los tests nuevos de `webhook.test.ts` y todos los existentes (incluidos los de canje de puntos, sin modificar) en verde.

- [ ] **Step 5: Commit**

```bash
git add worker/routes/webhook.ts test/routes/webhook.test.ts
git commit -m "feat: grant support packs from bits, subs, and gift subs"
```

---

### Task 5: Admin panel — etiquetas en español para el historial

**Files:**
- Modify: `src/admin.ts:42-54`
- Test: Create `src/admin.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `sourceLabel(source: string): string`, exportada para poder testearla sin DOM.

- [ ] **Step 1: Escribir el test**

`src/admin.test.ts`:

```ts
import { it, expect } from "vitest";
import { sourceLabel } from "./admin";

it("maps known pack sources to Spanish labels", () => {
  expect(sourceLabel("reward")).toBe("Recompensa");
  expect(sourceLabel("admin")).toBe("Admin");
  expect(sourceLabel("bits")).toBe("Bits");
  expect(sourceLabel("sub")).toBe("Suscripción");
  expect(sourceLabel("gift_sub")).toBe("Regalo sub");
});

it("falls back to the raw value for an unknown source", () => {
  expect(sourceLabel("unknown_source")).toBe("unknown_source");
});
```

- [ ] **Step 2: Ejecutar el test y confirmar que falla**

Run: `npx vitest run src/admin.test.ts`
Expected: FAIL con "sourceLabel is not a function" o similar — todavía no existe.

- [ ] **Step 3: Añadir `sourceLabel` y usarla en `renderHistory`**

En `src/admin.ts`, añade (cerca de las interfaces del principio del archivo):

```ts
const SOURCE_LABELS: Record<string, string> = {
  reward: "Recompensa",
  admin: "Admin",
  bits: "Bits",
  sub: "Suscripción",
  gift_sub: "Regalo sub",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}
```

Y en `renderHistory` (línea 54), cambia:

```ts
tdSource.textContent = h.source;
```

por:

```ts
tdSource.textContent = sourceLabel(h.source);
```

- [ ] **Step 4: Ejecutar el test y confirmar que pasa**

Run: `npx vitest run src/admin.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/admin.ts src/admin.test.ts
git commit -m "feat: show Spanish labels for pack sources in admin history"
```

---

### Task 6: Verificación final y despliegue

**Files:** ninguno nuevo — solo comandos de verificación.

**Interfaces:** N/A (task de cierre).

- [ ] **Step 1: Typecheck completo**

Run: `npx tsc --noEmit -p .`
Expected: sin errores.

- [ ] **Step 2: Suites de test completas**

Run: `npm run test:worker && npm test`
Expected: PASS en ambas.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build exitoso, sin warnings de tipo.

- [ ] **Step 4: Deploy**

Run: `npm run deploy`
Expected: deploy exitoso. Recordar al usuario que debe repetir `/api/auth/broadcaster-login` una vez para conceder los scopes nuevos (`bits:read`, `channel:read:subscriptions`) — si no, las subscripciones de bits/subs/gift-subs no llegarán a registrarse en Twitch aunque el código ya esté desplegado.
