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

**`migrations/0013_expand_pack_source.sql`** — SQLite no permite alterar un `CHECK` in-place, así que se reconstruye la tabla `packs` con el `CHECK` ampliado (sin `PRAGMA foreign_keys` en el proyecto, el rebuild es seguro):

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

`createEventSubSubscription` pasa de estar hardcodeado al tipo de canje de puntos a aceptar `type`, `version` y `condition` genéricos, para poder registrar los 5 tipos de subscripción desde `auth.ts`. Tolera 409 (ya registrada) para que reintentar el registro no rompa lo existente.

## `worker/routes/auth.ts` — `broadcaster-callback`

Amplía los scopes pedidos en `broadcaster-login` (`channel:read:redemptions` → añade `bits:read`, `channel:read:subscriptions`) y registra las 5 subscripciones (redemption + cheer + subscribe + subscription.message + subscription.gift) en vez de 1. El broadcaster tendrá que repetir el login una vez desplegado para conceder los scopes nuevos.

## `worker/routes/webhook.ts`

Se reescribe para despachar por `subscription.type` (viene en el body de la notificación, junto a `event` — Twitch siempre lo incluye ahí, y los tests existentes ya lo estaban poniendo en el body aunque el código actual lo ignore). Helpers nuevos: `upsertUser`, `grantPacks` (batch insert de N filas), `addBitsAndGetPackCount` (lee `bits_balance`, sube, calcula sobres y guarda el resto).

## Admin — historial (label en español)

`src/admin.ts` `renderHistory`: hoy `tdSource.textContent = h.source` muestra el valor crudo. Se extrae una función pura `sourceLabel(source: string): string` con el mapeo `reward→Recompensa, admin→Admin, bits→Bits, sub→Suscripción, gift_sub→Regalo sub` (fallback al valor crudo si no está en la tabla), para poder testearla sin DOM.

## Testing

En `test/webhook.test.ts` (Miniflare/D1): cheer por debajo del umbral, cheer que cruza el umbral (con resto), cheer que cruza varias veces en un solo evento, cheer anónimo ignorado, sub nueva concede, sub-regalo-al-receptor no concede (evita duplicar), renovación concede, gift-sub concede `total` al gifter, gift-sub anónimo no concede. El canje de puntos existente sigue funcionando igual (regresión, tests ya existentes).

En `test/lib/twitch.test.ts` y `test/routes/auth.test.ts`: adaptar al nuevo signature de `createEventSubSubscription` y verificar que se registran las 5 subscripciones con los scopes ampliados.

En `src/admin.test.ts` (nuevo): `sourceLabel` para cada valor conocido + fallback.

## Fuera de alcance

- Reintentos/colas si Twitch reenvía el mismo evento (Twitch ya reintenta notificaciones que no devuelven 2xx; no se añade deduplicación por `Twitch-Eventsub-Message-Id` porque el pipeline actual tampoco la tenía para el canje de puntos).
- Tope máximo de sobres por evento de gift (`total`) — se confía en el valor que manda Twitch, viene autenticado por HMAC.
- Integración con PayPal (sigue siendo grant manual, sin cambios aquí).
