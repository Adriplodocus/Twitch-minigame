# Sistema de monedas: descarte y conversión a shiny

## Problem

Los duplicados no tienen ningún uso una vez el jugador ya los tiene — se acumulan sin más. Objetivo: dar salida a los duplicados (sink), dar algo de control sobre qué cartas consigues sin romper la sorpresa de los sobres, y una razón extra para volver a la colección. Primera iteración: descartar cartas por monedas, y gastar monedas para convertir una carta normal en su versión shiny.

## Design

### Schema

Nueva migración `0024_coins.sql`:

```sql
ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0;
```

No hace falta tabla de historial — igual que `packs`/`trade_offers`, el saldo vive en `users.coins` y las mutaciones son directas.

### Valores (`worker/lib/coins.ts`)

Mismo patrón que `RARITY_WEIGHTS_BY_TIER` en `worker/lib/packs.ts` — constantes centralizadas, fáciles de retocar:

```ts
export const DISCARD_VALUE: Record<Rarity, number> = {
  common: 5,
  rare: 15,
  epic: 40,
  legendary: 150,
};

export const DISCARD_VALUE_SHINY: Record<Rarity, number> = {
  common: 40,
  rare: 120,
  epic: 320,
  legendary: 1200,
};

export const SHINY_CONVERSION_COST: Record<Rarity, number> = {
  common: 150,
  rare: 400,
  epic: 1000,
  legendary: 3500,
};
```

`isShinyCard` (ya existe en `packs.ts`) decide qué tabla de valor usar al descartar.

### Reglas de negocio

Ambas acciones operan sobre **cantidad disponible** (`quantity - reserved`, mismo cálculo que `availableQuantity` en `worker/routes/marketplace.ts`) — una carta reservada en una oferta de marketplace no se puede descartar ni convertir.

- **Descartar**: solo si `available > 1` tras la operación (mínimo 1 copia siempre se queda). Se descarta 1 copia por click.
- **Convertir a shiny**: solo si:
  - la carta no es ya shiny (id no termina en `-shiny`),
  - existe `id + "-shiny"` en la tabla `cards` (algunas formas — Minior, variantes hembra, etc. — no tienen par shiny; se añadirá ese arte antes de lanzar la feature, pero el check es dinámico así que si falta alguna, simplemente no se ofrece para esa),
  - `available >= 2` de la copia normal (se consume 1, queda mínimo 1 — nunca se pierde el progreso del álbum normal),
  - `coins >= SHINY_CONVERSION_COST[rarity]`.

### Endpoints (`worker/routes/collection.ts`)

**`POST /api/collection/discard { cardId: string }`**

1. `requireAuth`.
2. Lee `rarity` de `cards`, `quantity`/`reserved` de `user_cards` para `(user, cardId)`.
3. 404 si la carta no existe; 409 si `available <= 1`.
4. `UPDATE user_cards SET quantity = quantity - 1 WHERE user_id = ? AND card_id = ?` + `UPDATE users SET coins = coins + ? WHERE twitch_id = ?` (valor según `isShinyCard(cardId)` ? `DISCARD_VALUE_SHINY` : `DISCARD_VALUE`), en un solo `c.env.DB.batch`.
5. Respuesta: `{ ok: true, coins: <nuevo saldo> }`.

**`POST /api/collection/convert-shiny { cardId: string }`**

1. `requireAuth`.
2. 400 si `cardId` ya es shiny.
3. Verifica que `cardId + "-shiny"` existe en `cards` → 404 "No disponible en shiny" si no.
4. Lee `rarity`, `quantity`/`reserved` de la normal, y `coins` del usuario.
5. 409 si `available < 2`; 402 (o `{ error }` 400) si `coins < cost`.
6. Batch: decrementa quantity de la normal en 1, upsert +1 en la shiny (mismo `ON CONFLICT` que el insert de apertura de sobre en este mismo archivo), resta `cost` de `users.coins`.
7. Respuesta: `{ ok: true, coins: <nuevo saldo> }`.

Ambos endpoints devuelven el saldo actualizado para que el frontend no tenga que hacer un segundo fetch.

### `getMe` y saldo

`GET /api/auth/me` pasa a incluir `coins` (lee `users.coins`). `getMe()` en `src/api.ts` amplía su tipo de retorno con `coins: number`.

### Frontend

**`user-header.ts`**: tras `getMe()`, pinta el saldo en un nuevo elemento `#user-coins` del header (junto a avatar/nombre, en las páginas viewer: `index`, `collection`, `trade`, `offers`, `album`). Se actualiza localmente (sin refetch) cada vez que `discardCard`/`convertToShiny` devuelven el nuevo saldo — se emite un evento `coins-updated` en `document` con el nuevo valor; `user-header.ts` lo escucha y actualiza el contador.

**`card.ts`**: `renderCardHtml` gana un parámetro `showCoinActions = false`. Cuando es `true` y `card.quantity > 0`, añade dentro de `.info-tooltip`:

- Botón "Descartar (+N)" — visible si `quantity > 1` (usa `quantity` que ya llega neto de `reserved` desde `GET /api/collection`, ver `worker/routes/collection.ts:13`). Click → `discardCard(cardId)`, sin confirmación; en éxito, decrementa `quantity` en memoria, re-renderiza la carta, dispara `coins-updated`.
- Botón "Convertir a shiny (coste N)" — visible si `quantity >= 2`, la carta no es shiny, y existe su par shiny en `ownedCards`/catálogo cargado. Si `coins < cost`, se muestra deshabilitado con el coste igual. Click → cambia el botón a confirmación inline ("¿Seguro? Sí/No") dentro del mismo tooltip; al confirmar, llama `convertToShiny(cardId)`, en éxito recarga la colección (`load()`) porque aparece una carta nueva (la shiny) que antes podía no estar en `ownedCards`.

**`src/api.ts`**: nuevas funciones `discardCard(cardId: string): Promise<{ ok: true; coins: number }>` y `convertToShiny(cardId: string): Promise<{ ok: true; coins: number }>`, mismo wrapper `fetch` que el resto.

Solo `collection.ts` pasa `showCoinActions: true`. `trade.ts`, `album.ts`, `overlay.ts` siguen sin ellos (no cambia su llamada a `renderCardHtml`, el parámetro nuevo es opcional al final).

### Styling (`src/style.css`)

Reutiliza `.btn` existente para ambos botones dentro del tooltip, tamaño reducido (mismo patrón que otros botones compactos en `.info-tooltip`). Botón de conversión deshabilitado: `opacity: 0.5; cursor: not-allowed` (patrón ya usado en otros disabled del proyecto). `#user-coins`: texto `JetBrains Mono` con un icono de moneda simple (emoji o `.webp` pequeño), color `--gold`.

## Testing

Worker (`vitest.workers.config.ts`, nuevo `test/routes/coins.test.ts`):

- Descartar con `quantity=1` → 409, no cambia coins.
- Descartar con `quantity=3` de un common → `quantity=2`, `coins += 5`.
- Descartar una shiny (`id` con `-shiny`) → usa `DISCARD_VALUE_SHINY`.
- Descartar carta reservada (`quantity=2, reserved=1`, `available=1`) → 409.
- Convertir con `quantity=1` → 409.
- Convertir con `quantity=2`, coins insuficientes → 400/402, no toca `user_cards`.
- Convertir con `quantity=2`, coins suficientes → normal baja a 1, shiny sube a 1 (o se crea la fila si no existía), coins baja en `cost`.
- Convertir una carta que ya es shiny → 400.
- Convertir una carta sin par shiny en catálogo → 404.
- `GET /api/auth/me` incluye `coins`.

Frontend (`vitest.config.ts`): extender los tests de `card.ts` — con `showCoinActions: true` y `quantity` variable, verificar presencia/ausencia de cada botón según las reglas de arriba.

## Out of scope

- Sin historial/log de descartes o conversiones (ni para el usuario ni para admin).
- Sin límite diario ni cooldown en descarte/conversión.
- Sin "descartar todos los duplicados" en bloque — un click, una carta.
- No cubre los otros usos de monedas discutidos (comprar sobres, comodín de álbum, cosméticos) — quedan para una iteración futura.
- Las 110 cartas sin par shiny en el catálogo se resuelven añadiendo el arte que falta (fuera del alcance de este spec); hasta entonces esas cartas simplemente no muestran el botón de conversión.
