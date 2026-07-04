# Sobres automáticos configurables — Design

## Contexto

[[2026-07-04-eventsub-support-packs-design]] dejó las cantidades hardcodeadas en `worker/routes/webhook.ts`: 1 sobre por canje de puntos, 200 bits = 1 sobre, 1 sobre por sub/renovación, `total` sobres 1:1 por gift sub. El usuario quiere ajustar estos números desde el panel admin sin tocar código: cuántos sobres da cada caso, y para bits además cada cuántos bits se entrega uno.

## Almacenamiento

Migración nueva `migrations/0015_pack_grant_config.sql`, tabla de fila única (patrón simple, no hace falta key-value genérico para 5 campos fijos):

```sql
CREATE TABLE pack_grant_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reward_quantity INTEGER NOT NULL DEFAULT 1,
  bits_threshold INTEGER NOT NULL DEFAULT 200,
  bits_quantity INTEGER NOT NULL DEFAULT 1,
  sub_quantity INTEGER NOT NULL DEFAULT 1,
  gift_sub_multiplier INTEGER NOT NULL DEFAULT 1
);

INSERT INTO pack_grant_config (id) VALUES (1);
```

Los defaults reproducen el comportamiento actual — desplegar esta migración no cambia nada hasta que se edite desde el panel.

Rangos válidos: `reward_quantity`, `bits_quantity`, `sub_quantity`, `gift_sub_multiplier` ∈ [0, 1000] (0 desactiva ese caso concreto sin tocar código); `bits_threshold` ∈ [1, 1000] (no puede ser 0, división por cero).

## `worker/routes/webhook.ts`

Se añade `getPackGrantConfig(db): Promise<PackGrantConfig>` que lee la fila única (siempre existe, la inserta la migración). Sustituye las constantes fijas:

- Canje de puntos: `grantPacks(..., 1, ...)` → `grantPacks(..., config.reward_quantity, ...)`.
- Cheer: `addBitsAndGetPackCount(db, userId, bits)` pasa a `addBitsAndGetPackCount(db, userId, bits, config.bits_threshold, config.bits_quantity)`. Internamente: `crossings = floor(balance / threshold)`, `packs = crossings * quantity`, resto guardado = `balance % threshold`.
- Sub nueva / `subscription.message`: `grantPacks(..., 1, ...)` → `grantPacks(..., config.sub_quantity, ...)`.
- Gift sub: `grantPacks(..., event.total, ...)` → `grantPacks(..., event.total * config.gift_sub_multiplier, ...)`.

Se lee la config una vez por request al webhook (no se cachea entre requests — el volumen de eventos no lo justifica y evita servir config desactualizada tras un cambio reciente en el panel).

## API admin (`worker/routes/admin.ts`)

- `GET /api/admin/pack-grant-config` (requireAdmin) → `{ rewardQuantity, bitsThreshold, bitsQuantity, subQuantity, giftSubMultiplier }`.
- `PUT /api/admin/pack-grant-config` (requireAdmin) → body con los mismos 5 campos; valida enteros dentro de rango (400 si falta alguno o está fuera de rango); `UPDATE pack_grant_config SET ... WHERE id = 1`.

## UI admin (`admin.html` + `src/admin.ts`)

Nueva sección "Configuración de sobres automáticos", debajo de "Sobre de prueba", con el mismo patrón visual (inputs + botón + `<p>` de mensaje):

```html
<div style="margin-top: 2rem;">
  <h2>Configuración de sobres automáticos</h2>
  <div style="margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; max-width: 320px;">
    <label>Sobres por canje de puntos <input class="input" id="cfg-reward-quantity" type="number" min="0" max="1000" /></label>
    <label>Bits por sobre <input class="input" id="cfg-bits-threshold" type="number" min="1" max="1000" /></label>
    <label>Sobres por umbral de bits <input class="input" id="cfg-bits-quantity" type="number" min="0" max="1000" /></label>
    <label>Sobres por suscripción/renovación <input class="input" id="cfg-sub-quantity" type="number" min="0" max="1000" /></label>
    <label>Sobres por sub regalada <input class="input" id="cfg-gift-sub-multiplier" type="number" min="0" max="1000" /></label>
  </div>
  <button class="btn" id="cfg-save-btn" style="margin-top: 0.75rem;">Guardar configuración</button>
  <p id="cfg-message" style="margin-top: 0.5rem;"></p>
</div>
```

`admin.ts`: al entrar al panel (junto a `loadHistory()` en `login()`), `loadPackGrantConfig()` hace `GET` y rellena los 5 inputs. `savePackGrantConfig()` (en el listener de `cfg-save-btn`) lee los 5 inputs, hace `PUT`, y muestra éxito/error en `#cfg-message` — mismo patrón que `openTestPack()`.

## Testing

- `test/routes/webhook.test.ts`: cambiar `bits_threshold`/`bits_quantity`/`sub_quantity`/`reward_quantity`/`gift_sub_multiplier` vía `UPDATE pack_grant_config` antes del request y verificar que el webhook concede la cantidad configurada en cada uno de los 4 casos (no los valores fijos de antes).
- `test/routes/admin.test.ts`: `GET`/`PUT /pack-grant-config` — devuelve defaults, persiste cambios, rechaza valores fuera de rango o campos faltantes (400), rechaza sin sesión admin (401).

## Fuera de alcance

- Configurar el tier de cada caso (reward sigue siendo `gratis` fijo, los otros 3 siguen siendo `apoyo` fijo) — no se pidió, y tocar esto complicaría la migración de tiers ya cerrada en [[2026-07-04-pack-tiers-design]].
- Historial/auditoría de cambios de configuración (quién cambió qué y cuándo) — no se pidió.
