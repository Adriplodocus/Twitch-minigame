# Pack Tiers — Design

## Contexto

Hoy todos los sobres usan las mismas probabilidades (`RARITY_WEIGHTS` / `SHINY_CHANCE` / `CATEGORY_WEIGHTS` en `worker/lib/packs.ts`), sin importar cómo se consiguió el sobre. El reparto actual de fuentes es:

- Canje de recompensa de canal (automático, vía EventSub → `worker/routes/webhook.ts`)
- Suscripción, regalo de subs, bits (200 = 1 sobre), donación PayPal (2€ = 1 sobre) — **ninguna de estas está automatizada hoy**; todas se conceden a mano desde el panel admin (`worker/routes/admin.ts` `/grant-packs`, columna `packs.source = 'admin'`)

Se busca diferenciar la calidad del sobre según si fue gratis (canje) o de apoyo (sub/gift/bits/paypal), sin construir integraciones nuevas con Twitch o PayPal — el admin ya concede estos sobres manualmente y simplemente elegirá el tier al hacerlo.

## Cambios de datos

Migración nueva (`migrations/0009_pack_tier.sql`):

```sql
ALTER TABLE packs ADD COLUMN tier TEXT NOT NULL DEFAULT 'gratis'
  CHECK (tier IN ('gratis', 'apoyo'));
```

- `source` (reward/admin) se mantiene sin cambios — sigue distinguiendo "grant automático" de "grant manual" para el historial admin.
- `tier` es una dimensión independiente: qué probabilidades usa el sobre al abrirse.

## Flujo por origen

- **Canje de recompensa** (`webhook.ts`): el INSERT no cambia, usa el default `tier = 'gratis'`.
- **Grant manual** (`admin.ts` `/grant-packs`): el body pasa a requerir `tier: 'gratis' | 'apoyo'`. La UI admin añade un `<select>` con ambas opciones, **default `gratis`**. Se valida que `tier` sea uno de los dos valores permitidos; si falta o es inválido, 400.

## Probabilidades por tier

`worker/lib/packs.ts` pasa de tener un único `RARITY_WEIGHTS`/`SHINY_CHANCE` a una tabla indexada por tier:

```ts
export const RARITY_WEIGHTS_BY_TIER: Record<PackTier, Record<Rarity, number>> = {
  gratis: { common: 71.5, rare: 15, epic: 12, legendary: 1.5 },
  apoyo:  { common: 60,   rare: 20, epic: 16, legendary: 4 },
};

export const SHINY_CHANCE_BY_TIER: Record<PackTier, number> = {
  gratis: 0.005,
  apoyo: 0.01,
};
```

`CATEGORY_WEIGHTS` (inicial/mega/gmax) no cambia — queda igual para ambos tiers (5%/3%/3%).

`pickRandomCards` recibe un `tier` adicional y usa las tablas correspondientes en vez de las constantes fijas actuales. `buildCardWeights` recibe las weights ya resueltas para ese tier (misma lógica de reparto shiny/categoría que hoy, solo cambia el input).

## Apertura de sobre

`worker/routes/collection.ts` `/packs/:id/open`: el `SELECT` de la fila del pack ya trae todas sus columnas; se añade `tier` a la proyección y se pasa a `pickRandomCards(catalog.results, 10, pack.tier)`.

## Admin — historial

`GET /admin/history` añade `tier` a la proyección para que el panel muestre qué tier se concedió en cada grant manual.

## Testing

- `worker/lib/packs.test.ts`: casos nuevos para tier `gratis` vs `apoyo` — verificar que las weights usadas correspondan a la tabla esperada (distribución estadística sobre muchas muestras, como ya hace el test actual).
- Test de `/grant-packs`: rechaza `tier` ausente/inválido; concede con el tier indicado.
- Test de `/packs/:id/open`: el pack abierto respeta el tier con el que fue creado.

## Fuera de alcance

- Automatizar detección de sub/gift/bits vía EventSub de Twitch.
- Integración con PayPal.
- Tier "premium"/3er tier — se puede añadir después si hace falta, la tabla por tier ya está preparada para extenderse.
