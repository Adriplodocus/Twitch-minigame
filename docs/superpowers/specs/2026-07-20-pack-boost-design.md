# Boost de odds al abrir un sobre (pagado con coins)

## Problem

Las coins actuales (ver [[2026-07-20-coins-design]]) solo tienen un sumidero: convertir cartas a shiny. Objetivo: un segundo uso que además conecte con el momento de mayor emoción del juego — abrir el sobre — dejando al jugador decidir si invierte sus coins en mejorar las probabilidades de ESE sobre concreto, tanto de rareza como de shiny.

## Design

### Cálculo de odds boosteadas (`worker/lib/packs.ts`)

El boost es un **desplazamiento relativo fijo** aplicado encima del tier base del sobre (gratis o apoyo) — no una tabla absoluta — para que boostear un sobre de apoyo también valga la pena (nunca deja el sobre peor que sin boost). El desplazamiento es la mitad del gap gratis↔apoyo:

```ts
export const RARITY_BOOST_DELTA: Record<Rarity, number> = {
  common: -5.75,
  rare: 2.5,
  epic: 2,
  legendary: 1.25,
};

export const SHINY_BOOST_DELTA = 0.0025;
```

Resultado (referencia, no vive como tabla — se deriva sumando el delta):

| | Common | Rare | Epic | Legendary | Shiny |
|---|---|---|---|---|---|
| Gratis | 71.5% | 15% | 12% | 1.5% | 0.5% |
| Gratis + boost | 65.75% | 17.5% | 14% | 2.75% | 0.75% |
| Apoyo | 60% | 20% | 16% | 4% | 1% |
| Apoyo + boost | 54.25% | 22.5% | 18% | 5.25% | 1.25% |

`buildCardWeights` y `pickRandomCards` ganan un parámetro `boost: boolean`. Cuando es `true`, usan `RARITY_WEIGHTS_BY_TIER[tier][rarity] + RARITY_BOOST_DELTA[rarity]` y `SHINY_CHANCE_BY_TIER[tier] + SHINY_BOOST_DELTA` en vez de las tablas base. Resto del algoritmo (split por categoría inicial/mega/gmax, split shiny/no-shiny por especie) no cambia.

`pickRandomCards` ya tiene `random: () => number = Math.random` como 4º parámetro posicional, usado por los tests existentes (`sequenceRandom`, etc.) para determinismo. `boost` se inserta ANTES de `random`, no después: `pickRandomCards(catalog, count, tier, boost, random = Math.random)`. Los ~12 call sites en `packs.test.ts` que hoy pasan `random` como 4º argumento pasan a pasarlo como 5º (con `boost` explícito, típicamente `false`, como 4º). El call site real queda `pickRandomCards(catalog.results, 10, pack.tier, boost === true)`.

### Coste

150 coins fijo, sin importar el tier del sobre. Constante nueva en `worker/lib/coins.ts`:

```ts
export const PACK_BOOST_COST = 150;
```

### Endpoint (`worker/routes/collection.ts`)

`POST /api/collection/packs/:id/open` — body gana campo opcional `boost?: boolean` (junto al `generation` ya existente).

1. Validación de pack existente/propio/sin abrir — sin cambios.
2. Si `boost === true`: descuenta coins de forma atómica antes de repartir cartas —
   ```sql
   UPDATE users SET coins = coins - 150 WHERE twitch_id = ? AND coins >= 150 RETURNING coins
   ```
   Si no devuelve fila → `400 { error: "Not enough coins" }`, el sobre NO se abre (no se llega a `pickRandomCards`).
3. `pickRandomCards(catalog.results, 10, pack.tier, boost === true)`.
4. Igual que `discard`/`convert-shiny`, la respuesta siempre incluye el saldo actual: `{ cards, coins }`. Si hubo boost, `coins` es el valor devuelto por el `UPDATE ... RETURNING coins` del paso 2; si no, un `SELECT coins FROM users WHERE twitch_id = ?` adicional (mismo coste que ya paga `GET /collection`).

Mismo trade-off ya aceptado en `convert-shiny`: si el `c.env.DB.batch` de inserción de cartas fallara tras cobrar el boost, las coins quedan gastadas. Caso raro, no se corrige aquí (consistente con el resto del código de coins).

### Frontend

**`src/api.ts`**: `openPack` gana un tercer parámetro `boost: boolean = false`, se manda en el body junto a `generation`. Tipo de retorno pasa a `Promise<{ cards: CardView[]; coins?: number }>`.

**`src/collection.ts` — `openAlbumPickerModal`**: gana un checkbox de boost dentro del modal, entre la grid de generaciones y el botón cancelar:

```html
<label class="modal-boost-toggle">
  <input type="checkbox" id="modal-boost-checkbox" />
  Boostear odds (150 🪙)
</label>
```

- Recibe el saldo actual como parámetro (`openAlbumPickerModal(coins: number)`) — `collection.ts` ya tiene `coins` en memoria (viene de `getCollection()`, es lo mismo que usa `showCoinActions`).
- `PACK_BOOST_COST` se añade a `src/coins.ts` (mismo archivo que ya espeja `DISCARD_VALUE`/`SHINY_CONVERSION_COST` del backend), y el checkbox se renderiza `disabled` cuando `coins < PACK_BOOST_COST`, con el label en gris.
- Al confirmar generación, la promesa resuelve `{ generation, boost }` en vez de solo `generation`.
- `renderPendingPacks`'s `onOpen` callback y su única llamada (`collection.ts:148`) pasan `boost` a `openPack(packId, generation, boost)`.
- Si la respuesta de `openPack` trae `coins`, dispara el mismo evento `coins-updated` que usan `discard`/`convert-shiny` para refrescar el header.
- Si el fetch falla por `"Not enough coins"` (race: saldo bajó en otra pestaña entre abrir el modal y confirmar) — error inline en el modal (mismo patrón que errores existentes en `collection.ts`, ver `showCoinActionError`), el modal no se cierra, el sobre no se marca como abierto.

**Feedback visual de sobre boosteado**: reusa el mecanismo de `pack-tier-foil.ts`/CSS que ya distingue `apoyo` (borde, ribbon "★"). Para boost se usa una variante visual distinta (icono "⚡" en vez de "★", mismo `pack-apoyo-corner`/`pack-apoyo-ribbon` con clase modificadora) para no confundirse con el tier apoyo real — se aplica solo momentáneamente durante la animación de apertura (`img.classList.add("opening")`), no es estado persistente del pack en `pendingPacks` (el boost se decide en el momento de abrir, no se guarda en la fila `packs`).

### Styling (`src/style.css`)

`.modal-boost-toggle`: fila flex con checkbox + label, mismo `font-family: 'JetBrains Mono'` del resto del modal. Disabled: `opacity: 0.5; cursor: not-allowed` (mismo patrón que el botón de conversión a shiny en el tooltip).

## Testing

Worker (`vitest.workers.config.ts`, extiende `worker/lib/packs.test.ts` y añade casos en `test/routes/collection.test.ts` o similar):

- `pickRandomCards` con `boost=true` sobre tier `gratis`: distribución de rareza se acerca al punto medio gratis/apoyo (test estadístico con muestra grande, mismo estilo que los tests de tier existentes).
- `pickRandomCards` con `boost=true` sobre tier `apoyo`: rareza mejor que `apoyo` sin boost.
- Abrir sobre con `boost: true` y coins suficientes → coins bajan en 150, cartas reflejan odds boosteadas (vía mock/seed determinista si el test de integración no puede ser estadístico).
- Abrir sobre con `boost: true` y coins insuficientes → 400, pack sigue sin abrir (`opened_at IS NULL`), coins sin cambios.
- Abrir sobre sin `boost` (u omitiendo el campo) → comportamiento actual sin cambios, no toca coins.

Frontend (`vitest.config.ts`): si `openAlbumPickerModal` se testea actualmente (revisar), extender para checkbox disabled cuando `coins < 150` y para que resuelva `{ generation, boost }`.

## Out of scope

- Sin niveles de boost adicionales (solo un nivel fijo, un coste fijo).
- Sin "boost permanente"/nivel de cuenta — se paga sobre por sobre.
- No cambia `admin.ts` (grants manuales, sobres de test) — el boost es una acción exclusiva del jugador sobre sus propios sobres pendientes.
- No persiste si un sobre "iba a boostearse" en la fila `packs` — es una decisión tomada en el momento de `POST .../open`, no un estado del pack en cola.
