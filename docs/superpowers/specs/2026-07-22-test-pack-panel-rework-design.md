# Rework del panel "Sobre de prueba" (admin)

## Objetivo

El panel de sobre de prueba del admin (`admin.html` / `src/admin.ts` /
`POST /api/admin/test-pack`) hoy obliga a rellenar 5 campos que sumen 10 a
mano, no permite forzar un shiny de una rareza concreta (p. ej. legendario
shiny), y nunca marca cartas como NEW (el test-pack no toca la colección
real, así que `isNew` nunca se calculaba). Este cambio resuelve los tres
puntos.

## Layout (`admin.html`)

La fila 1 (generación / tier / botón "Abrir sobre de prueba") no cambia —
ya cumple lo pedido.

La fila 2 pasa de 5 campos sueltos a dos columnas:

```
Normales                    Shiny
Common  [__]                Common  [__]
Rare    [__]                Rare    [__]
Epic    [__]                Epic    [__]
Legendary [__]              Legendary [__]
```

IDs: `tp-common`, `tp-rare`, `tp-epic`, `tp-legendary` (normales, ya
existían), `tp-shiny-common`, `tp-shiny-rare`, `tp-shiny-epic`,
`tp-shiny-legendary` (nuevos, sustituyen al único `tp-shiny`).

Fila 3 añade un campo nuevo `tp-new-count` ("Marcar como NEW", 0-10).

## Auto-fill de Common normal (`src/admin.ts`)

Cada uno de los otros 7 campos (`tp-rare`, `tp-epic`, `tp-legendary`,
`tp-shiny-common`, `tp-shiny-rare`, `tp-shiny-epic`,
`tp-shiny-legendary`) lleva un listener `input` que recalcula:

```
tp-common.value = max(0, 10 - suma(los otros 7))
```

`tp-common` sigue siendo editable a mano, pero cualquier cambio en los
otros 7 lo sobreescribe. Si el usuario deja los 7 en 0 sin tocar nada,
`tp-common` se queda en su valor inicial (0) — el auto-fill solo se
dispara por el evento `input` de los otros campos, nunca en la carga de
la página. Si el usuario toca algo y luego lo revierte a 0, `tp-common`
queda en 10 (fuerza un sobre "todo común") en lugar de volver al modo de
probabilidades reales — comportamiento aceptado explícitamente.

La validación existente de "la suma debe ser 10" en el backend no cambia
de comportamiento — sigue siendo la que corta el paso si el usuario deja
algo inconsistente.

## Shiny por rareza (`worker/lib/packs.ts`, `worker/routes/admin.ts`)

`ExactCounts` pasa de:

```typescript
export interface ExactCounts {
  common: number;
  rare: number;
  epic: number;
  legendary: number;
  shiny: number;
}
```

a:

```typescript
export interface ExactCounts {
  common: number;
  rare: number;
  epic: number;
  legendary: number;
  shinyCommon: number;
  shinyRare: number;
  shinyEpic: number;
  shinyLegendary: number;
}
```

`pickExactCards` pasa de iterar 4 rarezas no-shiny + 1 bucket shiny
genérico, a iterar 8 buckets (rareza × shiny/no-shiny), cada uno filtrando
`catalog` por `card.rarity === rarity && isShinyCard(card.id) === shiny`.
Los cromos shiny ya llevan su `rarity` real en el catálogo (un legendario
shiny tiene `rarity: "legendary"`), así que no hace falta ningún cambio de
esquema de datos, solo de la función de filtrado. El resto del algoritmo
(agrupar por especie con `groupBySpecies`, elegir con
`pickCardBySpecies`, barajar al final) no cambia.

Si un bucket pedido no tiene cartas en esa generación, se lanza el mismo
tipo de error que hoy (p. ej. `"No hay cartas legendary shiny en esta
generación"`), y la ruta responde 400 igual que ahora.

## Marcar cartas como NEW (`worker/routes/admin.ts`)

`POST /api/admin/test-pack` acepta un campo opcional `newCount` (entero,
0-10, default 0). Tras resolver `picked` (con counts forzados o con sorteo
real — ambos casos), las primeras `newCount` cartas del array final
llevan `isNew: true` en la respuesta; el resto `isNew: false`. No hace
falta ninguna lógica de "primera vez" real (el test-pack no consulta
`user_cards`) — es puramente para poder ver el badge en el reveal.

`src/admin.ts` añade `readTestPackNewCount()` y siempre envía `newCount`
en el body de `/test-pack` (independiente de si se están forzando counts
o no).

## Fuera de alcance

- No se toca el flujo real de apertura de sobres (`worker/routes/collection.ts`),
  ya cubierto por el badge NEW real.
- No se añade selección de qué cartas concretas llevan NEW — son "las
  primeras N del resultado", sin control fino por rareza.

## Testing

- `test/lib/packs.test.ts`: actualizar los tests de `pickExactCards` al
  nuevo shape de `ExactCounts` (sustituir `shiny` por
  `shinyCommon/shinyRare/shinyEpic/shinyLegendary`); añadir un test que
  fuerce `shinyLegendary` y compruebe que solo devuelve legendarios shiny.
- `test/routes/admin.test.ts`: actualizar el test de "composición forzada"
  y el de "rechaza suma != 10" al nuevo shape; añadir un test de
  `newCount` que compruebe que las primeras N cartas de la respuesta
  llevan `isNew: true` y el resto `isNew: false`.
- No hay test unitario de `src/admin.ts` hoy (no existe
  `src/admin.test.ts`); la parte de UI se verifica a mano en el navegador
  tras el cambio.
