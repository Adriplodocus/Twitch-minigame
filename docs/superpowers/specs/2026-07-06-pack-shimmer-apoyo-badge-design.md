# Shimmer en todos los sobres + cinta distintiva para sobre de apoyo

## Problem

El shimmer (bounce + brillo diagonal vía `transform`, arreglado hoy tras 3 iteraciones de debugging) hoy solo se aplica al sobre `apoyo` (`shouldShowFoil(pack.tier)` en `src/collection.ts:96`). Queda tan bien que se quiere en todos los sobres pendientes, gratis incluidos. Eso deja al sobre `apoyo` sin nada que lo distinga aparte del borde dorado sutil (2px) — hace falta una señal extra.

## Design

### Shimmer para todos los sobres

`renderPendingPacks` (`src/collection.ts:81-108`) deja de condicionar la creación de `.pack-wrapper`/`.pack-foil-shine` a `shouldShowFoil(pack.tier)`. Todo pack pendiente se envuelve en `.pack-wrapper` (bounce `pack-idle` + `.pack-foil-shine` con el sweep `::before`/`transform` ya arreglado). La clase `apoyo` se sigue añadiendo condicionalmente, ahora solo para el borde dorado y la cinta nueva — ya no gatilla el wrapper en sí.

`style.css`: la regla `.pack-wrapper.apoyo { animation: pack-idle ... }` (línea 163) pasa a `.pack-wrapper` a secas (bounce para todos); `.pack-wrapper.apoyo .pack-open-img { animation: none; border: 2px solid var(--gold); }` se queda igual (solo apoyo pierde animación propia del img porque el wrapper ya la lleva — pero eso también debe aplicar a los packs sin `apoyo` ahora que ellos también llevan wrapper, así que el `animation: none` en `.pack-open-img` cuando está dentro de cualquier `.pack-wrapper` se generaliza, no solo `.apoyo`).

### Cinta distintiva del sobre apoyo

Solo `.pack-wrapper.apoyo` añade:
- Borde dorado en el img (ya existe, sin cambios)
- Cinta diagonal esquina superior-izquierda con ★ — patrón CSS estándar de "corner ribbon": `.pack-wrapper.apoyo` gana `overflow: hidden`, un nuevo div `.pack-apoyo-ribbon` (contenido `★`, texto blanco sobre fondo dorado) posicionado `absolute`, rotado `-45deg`, cruzando la esquina.

Creado en `renderPendingPacks` junto al resto de elementos del pack `apoyo` (mismo bloque `if (shouldShowFoil(pack.tier))`), como hijo más de `.pack-wrapper`.

Trade-off aceptado: `overflow: hidden` en `.pack-wrapper.apoyo` recorta el hover-pop (`translateY(-4px) scale(1.03)`, ~2px) del sobre apoyo — imperceptible, y es el recorte estándar que ya usa este patrón de cinta en cualquier sitio que lo implementa.

### Fuera de alcance

- Cinta/badge en cartas individuales reveladas (solo aplica al ícono de sobre sin abrir).
- Texto en la cinta (solo ícono ★, decidido en brainstorming).
- Cambios al overlay.html / pack-reveal (esto es solo `collection.ts`/`style.css`).

## Testing

- `npx tsc --noEmit` y `npm test` (suite existente, sin tests nuevos — el cambio es puramente de rendering/CSS, no hay lógica pura nueva que testear; `renderPendingPacks` no está exportada y ya no se testea unitariamente hoy).
- Verificación manual: abrir `/collection.html` con sobres gratis y apoyo pendientes, confirmar bounce+shimmer en ambos, cinta+borde solo en apoyo.
