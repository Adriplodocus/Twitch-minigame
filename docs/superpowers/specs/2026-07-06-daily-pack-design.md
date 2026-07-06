# Sobre diario gratis

## Problem

Queremos dar un incentivo diario para volver a la web: una vez al día, cada viewer puede reclamar un sobre gratis desde un botón en el header. Debe ser imposible reclamar dos veces el mismo día (multi-pestaña, doble-click, llamadas directas a la API).

## Design

### Schema

`0017_daily_pack_source.sql` — rebuild de `packs` (mismo patrón que `0013_expand_pack_source.sql`) para añadir `'daily'` al `CHECK` de `source`:

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

INSERT INTO packs_new SELECT * FROM packs;
DROP TABLE packs;
ALTER TABLE packs_new RENAME TO packs;
CREATE INDEX idx_packs_user ON packs(user_id);
```

`0018_daily_pack_claims.sql`:

```sql
CREATE TABLE daily_pack_claims (
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  claim_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, claim_date)
);
```

`claim_date` siempre calculada en SQL (`date('now')`, UTC) — nunca recibida del cliente.

### Anti-cheat mechanism

Reclamar es un solo `INSERT INTO daily_pack_claims (user_id, claim_date) VALUES (?, date('now'))`. La `PRIMARY KEY (user_id, claim_date)` hace que un segundo insert el mismo día para el mismo user falle con `SQLITE_CONSTRAINT`. D1/SQLite serializa escrituras, así que dos requests concurrentes (dos pestañas, doble-click, o llamada directa a la API) siempre resuelven en exactamente un insert exitoso — no hay ventana de carrera entre "leer si ya reclamó" y "escribir el claim" porque no se hace lectura previa, se intenta escribir directamente y se interpreta el fallo de constraint como "ya reclamado".

### Backend

Nuevo `worker/routes/daily-pack.ts`, montado en `/api/daily-pack`, todas las rutas con `requireAuth`:

- `GET /status` → `{ claimed: boolean }`. `SELECT 1 FROM daily_pack_claims WHERE user_id = ? AND claim_date = date('now')`.
- `POST /claim`:
  1. Intentar `INSERT INTO daily_pack_claims (user_id, claim_date) VALUES (?, date('now'))`.
  2. Si el insert lanza (mensaje contiene `UNIQUE constraint failed`) → `409 { error: "Ya reclamado hoy" }`.
  3. Si el insert tiene éxito → `INSERT INTO packs (user_id, source, tier) VALUES (?, 'daily', 'gratis')` → `200 { ok: true }`.

`worker/index.ts`: montar `daily-pack` bajo `/api/daily-pack`, junto a los demás route groups.

### Frontend

`api.ts` — nuevas funciones:

```ts
export function getDailyPackStatus(): Promise<{ claimed: boolean }> { ... }
export function claimDailyPack(): Promise<{ ok: true } | { error: string }> { ... }
```

Botón nuevo en `page-header-actions`, primero de la lista, en las 4 páginas viewer (`collection.html`, `trade.html`, `offers.html`, `album.html`):

```html
<button class="btn btn-daily-pack" id="daily-pack-btn" type="button">
  🎁 Reclama tu sobre diario
</button>
```

`user-header.ts` (`initUserHeader`) — al cargar, `getDailyPackStatus()` y pintar:
- `claimed: false` → botón habilitado, texto "🎁 Reclama tu sobre diario".
- `claimed: true` → botón `disabled`, texto "✅ Sobre reclamado hoy".

Al click (solo si no disabled): `claimDailyPack()`.
- Éxito (`ok: true`) → disable + texto "✅ Sobre reclamado hoy".
- `409` → mismo resultado visual que éxito (perdió la carrera, ya estaba reclamado) — no se trata como error de usuario.
- Cualquier otro error de red → dejar el botón habilitado, no cambiar texto (permite reintentar).

El sobre creado queda `opened_at IS NULL`, igual que cualquier otro — aparece automáticamente en `pending-packs` de `collection.html` vía el `GET /api/collection` ya existente. No hace falta UI de apertura nueva.

### Styling (`src/style.css`)

`.btn-daily-pack`: pill button con acento `--pink` (glow `rgba(255,86,180,0.15)` en hover, como `.card:hover`), `:disabled` con opacidad reducida y `cursor: not-allowed`, sin hover glow.

## Testing

- Worker (`vitest.workers.config.ts`):
  - `POST /claim` sin claim previo → `200`, crea fila en `daily_pack_claims` y un pack `source='daily', tier='gratis'`.
  - Segundo `POST /claim` mismo día → `409`, no crea un segundo pack.
  - Concurrencia: disparar dos `POST /claim` con `Promise.all` → exactamente una respuesta `200` y una `409`; exactamente un pack `source='daily'` para ese user ese día.
  - `GET /status` refleja `claimed` antes/después de reclamar.
- Frontend (`vitest.config.ts`): extender el patrón de `how-to-get-packs.test.ts` — `id="daily-pack-btn"` presente en las 4 páginas viewer, ausente en `admin.html`.

## Out of scope

- No countdown/temporizador hasta el próximo reset (el botón simplemente queda disabled hasta que el usuario recargue al día siguiente).
- No previene multi-cuenta (varias cuentas de Twitch reclamando cada una la suya) — fuera de alcance, es comportamiento normal por-cuenta.
- No animación de apertura especial — reutiliza el flujo de apertura de sobres ya existente.
