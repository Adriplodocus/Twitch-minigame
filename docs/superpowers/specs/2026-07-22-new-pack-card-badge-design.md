# Badge "NEW" en cartas al abrir sobre

## Objetivo

Cuando un usuario abre un sobre, cada carta revelada que sea la primera copia que
ese usuario obtiene de esa carta concreta (card id exacto — shiny, hembra, mega,
etc. cuentan como cartas distintas) muestra un badge "NEW" en la reveal view.

## Alcance

- Solo la vista de apertura propia del usuario (`collection.ts` → `pack-reveal.ts`).
- El overlay de OBS (stream) **no** muestra el badge — fuera de alcance para
  mantener el cambio simple (el overlay recibe los datos del pack tras
  broadcast, no en el momento de apertura, y añadirlo requeriría persistir
  `isNew` por `pack_card`).
- El badge es efímero: no se persiste en DB, se calcula una sola vez en la
  respuesta de `/packs/:id/open`.

## Backend — `worker/routes/collection.ts` (`POST /packs/:id/open`)

Antes del `INSERT ... ON CONFLICT DO UPDATE` que suma cantidades en
`user_cards`, se consulta qué ids del pack ya poseía el usuario:

```sql
SELECT card_id FROM user_cards
WHERE user_id = ? AND card_id IN (<uniqueIds>) AND quantity > 0
```

Con ese set (`ownedBefore`), para cada id único del pack:
`isNew = !ownedBefore.has(id)`.

Ese flag se aplica a **todas** las instancias de esa carta dentro del array
`cards` de la respuesta — si el sobre da 2 copias de una carta nueva, ambas
llevan `isNew: true` (es un único evento de "primera vez", no importa el
orden dentro del mismo sobre).

La query de "owned before" debe ejecutarse antes del batch de inserts (usa el
mismo `uniqueIds` que ya se calcula para `cardDetails`).

## Tipos

`CardView` (`src/api.ts`): nuevo campo opcional `isNew?: boolean`. Queda
`undefined` en cualquier otra respuesta (collection listing, trade, overlay,
marketplace) — solo lo puebla el endpoint de open-pack.

## Frontend — `src/card.ts` (`renderCardHtml`)

Cuando `card.isNew` es true, se añade un badge dentro del `.card`, superpuesto
sobre el área del arte (no sobre el borde de la carta):

```html
<span class="card-badge-new">✦ New</span>
```

Estilo (variante "C" aprobada por el usuario vía mockup visual — etiqueta
dorada con sparkle, esquinas cuadradas, encima del arte):

```css
.card-badge-new {
  position: absolute;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--gold);
  color: var(--text-em);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 0.2rem 0.6rem 0.2rem 0.45rem;
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(120, 90, 60, 0.3);
  z-index: 2;
}
```

Posición top-center no choca con `.shiny-icon` (top-left) ni `.gender-icon`
(top-right), así que aparece junto a ambos sin solapar en cartas shiny o con
variante de género.

`pack-reveal.ts` no necesita cambios — ya pasa el `CardView` completo
(incluido `isNew`) a `renderCardHtml`.

## Testing

- `src/card.test.ts`: `renderCardHtml` con `isNew: true` → el HTML contiene
  `card-badge-new`; sin `isNew` o `isNew: false` → ausente.
- Worker test (`vitest.workers.config.ts`) para `/packs/:id/open`:
  - Primera vez que un usuario recibe la carta X → `isNew: true` en la
    respuesta.
  - Abrir un segundo sobre que también incluya la carta X → `isNew: false`.
  - Un mismo sobre que reparte la carta X dos veces (nunca poseída antes) →
    ambas instancias en la respuesta con `isNew: true`.

## Fuera de alcance

- Overlay de stream (ver "Alcance").
- Agrupar por especie (shiny cuenta como carta nueva aunque ya tengas el
  normal — decisión explícita del usuario).
