# Sobres automáticos por bits/subs/gift subs — Design

## Contexto

[[2026-07-04-pack-tiers-design]] dejó explícitamente fuera de alcance "automatizar detección de sub/gift/bits vía EventSub de Twitch" — hoy esos sobres de apoyo se conceden a mano desde el panel admin (`worker/routes/admin.ts` `/grant-packs`). Este spec cierra ese hueco: los sobres de apoyo se conceden automáticamente vía EventSub, igual que ya ocurre con el canje de puntos de canal (`worker/routes/webhook.ts`).

Reglas de negocio (dadas por el usuario):
- 200 bits acumulados = 1 sobre.
- 1 sobre por cada suscripción (incluye renovaciones mensuales, no solo la primera vez).
- 1 sobre por cada suscripción regalada.
- Todos estos sobres son tier `apoyo`.

## Eventos de Twitch usados

| Evento EventSub | Dispara sobre a | Condición |
|---|---|---|
| `channel.cheer` | quien anima (`user_id`) | ignorar si `is_anonymous` o sin `user_id` |
| `channel.subscribe` | quien se suscribe (`user_id`) | solo si `is_gift = false` — las de regalo las cubre el evento de gift para no duplicar |
| `channel.subscription.message` | quien renueva (`user_id`) | siempre (dispara una vez por mes renovado) |
| `channel.subscription.gift` | quien regala (`user_id`) | ignorar si `is_anonymous` o sin `user_id`; concede `total` sobres (subs regaladas en ese lote) |

`channel.subscribe` con `is_gift = true` (el receptor del regalo) no concede nada — ya se cubre vía `channel.subscription.gift` al gifter.

## Cambios de datos

**`migrations/0013_expand_pack_source.sql`** — SQLite no permite alterar un `CHECK` in-place, así que se reconstruye la tabla `packs` con el `CHECK` ampliado:

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

**`migrations/0014_user_bits_balance.sql`**:

```sql
ALTER TABLE users ADD COLUMN bits_balance INTEGER NOT NULL DEFAULT 0;
```

`bits_balance` guarda el resto (0–199) de bits acumulados que aún no ha completado un sobre. Se resetea a ese resto en cada cheer, no se acumula sin límite.

## `worker/lib/twitch.ts`

`createEventSubSubscription` pasa de estar hardcodeado al tipo de canje de puntos a aceptar `type` y `condition` genéricos:

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
    headers: { Authorization: `Bearer ${opts.accessToken}`, "Client-Id": opts.clientId, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: opts.type,
      version: opts.version,
      condition: opts.condition,
      transport: { method: "webhook", callback: opts.callbackUrl, secret: opts.secret },
    }),
  });
  // 409 = ya registrada (re-ejecutar el login no debe romper lo existente)
  if (!res.ok && res.status !== 409) throw new Error(`EventSub subscription creation failed (${opts.type}): ${res.status}`);
}
```

## `worker/routes/auth.ts` — `broadcaster-callback`

Amplía los scopes pedidos en `broadcaster-login`:

```ts
scopes: ["channel:read:redemptions", "bits:read", "channel:read:subscriptions"],
```

Y tras obtener el app access token, registra las 5 subscripciones en vez de 1:

```ts
const callbackUrl = new URL("/webhook/eventsub", c.req.url).toString();
const broadcasterId = c.env.TWITCH_BROADCASTER_ID;
const subs: { type: string; version: string; condition: Record<string, string> }[] = [
  { type: "channel.channel_points_custom_reward_redemption.add", version: "1", condition: { broadcaster_user_id: broadcasterId, reward_id: c.env.TWITCH_REWARD_ID } },
  { type: "channel.cheer", version: "1", condition: { broadcaster_user_id: broadcasterId } },
  { type: "channel.subscribe", version: "1", condition: { broadcaster_user_id: broadcasterId } },
  { type: "channel.subscription.message", version: "1", condition: { broadcaster_user_id: broadcasterId } },
  { type: "channel.subscription.gift", version: "1", condition: { broadcaster_user_id: broadcasterId } },
];
for (const sub of subs) {
  await twitch.createEventSubSubscription({ accessToken: appAccessToken, clientId: c.env.TWITCH_CLIENT_ID, callbackUrl, secret: c.env.TWITCH_EVENTSUB_SECRET, ...sub });
}
```

Nota operativa: el broadcaster tiene que repetir el login (`/api/auth/broadcaster-login`) una vez desplegado, para conceder los scopes nuevos (`bits:read`, `channel:read:subscriptions`) — el token actual no los tiene.

## `worker/routes/webhook.ts`

Se reescribe para despachar por `Twitch-Eventsub-Subscription-Type` en vez de asumir siempre canje de puntos. Helpers locales:

```ts
const BITS_PER_PACK = 200;

async function upsertUser(db: D1Database, userId: string, username: string): Promise<void> {
  await db.prepare(
    `INSERT INTO users (twitch_id, username) VALUES (?, ?)
     ON CONFLICT(twitch_id) DO UPDATE SET username = excluded.username`
  ).bind(userId, username).run();
}

async function grantPacks(db: D1Database, userId: string, quantity: number, source: string, tier: PackTier): Promise<void> {
  if (quantity < 1) return;
  const statements = Array.from({ length: quantity }, () =>
    db.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, ?, ?)").bind(userId, source, tier)
  );
  await db.batch(statements);
}

async function addBitsAndGetPackCount(db: D1Database, userId: string, bits: number): Promise<number> {
  const row = await db.prepare("SELECT bits_balance FROM users WHERE twitch_id = ?").bind(userId).first<{ bits_balance: number }>();
  const balance = (row?.bits_balance ?? 0) + bits;
  await db.prepare("UPDATE users SET bits_balance = ? WHERE twitch_id = ?").bind(balance % BITS_PER_PACK, userId).run();
  return Math.floor(balance / BITS_PER_PACK);
}
```

Despacho principal (reemplaza el bloque `if (messageType === "notification" && payload.event)` actual):

```ts
const subscriptionType = c.req.header("Twitch-Eventsub-Subscription-Type") ?? "";

if (messageType === "notification" && payload.event) {
  const event = payload.event;
  switch (subscriptionType) {
    case "channel.channel_points_custom_reward_redemption.add":
      if (event.reward.id !== c.env.TWITCH_REWARD_ID) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      await grantPacks(c.env.DB, event.user_id, 1, "reward", "gratis");
      break;

    case "channel.cheer": {
      if (event.is_anonymous || !event.user_id) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      const packs = await addBitsAndGetPackCount(c.env.DB, event.user_id, event.bits);
      await grantPacks(c.env.DB, event.user_id, packs, "bits", "apoyo");
      break;
    }

    case "channel.subscribe":
      if (event.is_gift) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      await grantPacks(c.env.DB, event.user_id, 1, "sub", "apoyo");
      break;

    case "channel.subscription.message":
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      await grantPacks(c.env.DB, event.user_id, 1, "sub", "apoyo");
      break;

    case "channel.subscription.gift":
      if (event.is_anonymous || !event.user_id) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      await grantPacks(c.env.DB, event.user_id, event.total, "gift_sub", "apoyo");
      break;
  }
  return c.json({ ok: true }, 200);
}
```

La verificación de firma HMAC y el manejo de `webhook_callback_verification` no cambian.

## Admin — historial (label en español)

`src/admin.ts` `renderHistory`: hoy `tdSource.textContent = h.source` muestra el valor crudo. Se añade un mapeo:

```ts
const SOURCE_LABELS: Record<string, string> = {
  reward: "Recompensa",
  admin: "Admin",
  bits: "Bits",
  sub: "Suscripción",
  gift_sub: "Regalo sub",
};
tdSource.textContent = SOURCE_LABELS[h.source] ?? h.source;
```

## Testing

En `test/webhook.test.ts` (Miniflare/D1, vía `vitest.workers.config.ts`):

- Cheer: bits por debajo del umbral no concede sobre y deja `bits_balance` actualizado; cruzar el umbral concede 1 sobre y guarda el resto; acumular en cheers sucesivos hasta cruzar varias veces concede varios sobres a lo largo del tiempo.
- Cheer anónimo (`is_anonymous: true` o sin `user_id`): no concede nada, no crea usuario.
- `channel.subscribe` con `is_gift: false`: concede 1 sobre tier `apoyo`.
- `channel.subscribe` con `is_gift: true`: no concede nada (evita duplicar con el evento de gift).
- `channel.subscription.message`: concede 1 sobre tier `apoyo`.
- `channel.subscription.gift`: concede `total` sobres al gifter; si `is_anonymous`, no concede nada.
- El canje de puntos existente (`channel.channel_points_custom_reward_redemption.add`) sigue funcionando igual (regresión).

## Fuera de alcance

- Reintentos/colas si Twitch reenvía el mismo evento (Twitch ya reintenta notificaciones que no devuelven 2xx; no se añade deduplicación por `Twitch-Eventsub-Message-Id` porque el pipeline actual tampoco la tenía para el canje de puntos).
- Tope máximo de sobres por evento de gift (`total`) — se confía en el valor que manda Twitch, viene autenticado por HMAC.
- Integración con PayPal (sigue siendo grant manual, sin cambios aquí).
