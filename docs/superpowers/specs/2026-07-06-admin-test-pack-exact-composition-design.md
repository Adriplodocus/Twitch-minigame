# Composición exacta en el sobre de prueba (common/rare/epic/legendary/shiny)

## Problem

Hoy el sobre de prueba admin usa `pickRandomCards` (probabilidades reales por tier) — para ver una carta legendaria o shiny hay que abrir muchos sobres seguidos. Se quiere poder forzar cuántas cartas de cada rareza (y cuántas shiny) salen, sin tocar las probabilidades reales del juego.

## Design

### `worker/lib/packs.ts` — `pickExactCards`

```ts
export interface ExactCounts {
  common: number;
  rare: number;
  epic: number;
  legendary: number;
  shiny: number;
}

export function pickExactCards<T extends { id: string; rarity: Rarity }>(
  catalog: T[],
  counts: ExactCounts,
  random: () => number = Math.random
): T[]
```

Para cada rareza en `["common", "rare", "epic", "legendary"]`: filtra `catalog` a esa rareza y `!isShinyCard(card.id)`, elige `counts[rarity]` cartas al azar (con repetición, `random()` para el índice) de ese subconjunto. Si `counts[rarity] > 0` y el subconjunto está vacío → `throw new Error("No hay cartas <rarity> no-shiny en esta generación")`.

Para `shiny`: filtra `catalog` a `isShinyCard(card.id)` (cualquier rareza), elige `counts.shiny` cartas al azar de ese subconjunto. Si `counts.shiny > 0` y vacío → `throw new Error("No hay cartas shiny en esta generación")`.

Devuelve todas las cartas elegidas en un array, barajado (Fisher-Yates con el mismo `random()`) para que el reveal no muestre siempre legendarios/shiny al final.

### `worker/routes/admin.ts` — `POST /test-pack`

Body gana `counts?: ExactCounts` opcional.

- `counts` ausente, o los 5 valores son 0 → comportamiento actual: `pickRandomCards(catalog.results, 10, tier)`.
- Algún valor de `counts` > 0 → valida que los 5 sean enteros ≥ 0 (400 `{error: "Invalid counts"}` si no) y que sumen exactamente 10 (400 `{error: "La suma debe ser 10"}` si no). Llama a `pickExactCards(catalog.results, counts)`. Si lanza (bucket vacío) → captura y devuelve 400 con `e.message` como `error`.

El resto del endpoint (insert pack, pack_cards, fetch card details, respuesta `{packId, cards}`) no cambia — `tier` se sigue guardando en `packs.tier` igual que hoy, solo deja de influir en el pick cuando se fuerzan cantidades.

### Frontend

**`admin.html`**: 5 inputs numéricos junto al selector de tier en la sección "Sobre de prueba":

```html
<div class="test-pack-counts">
  <label>Common <input type="number" min="0" id="tp-common" value="0" class="input" /></label>
  <label>Rare <input type="number" min="0" id="tp-rare" value="0" class="input" /></label>
  <label>Epic <input type="number" min="0" id="tp-epic" value="0" class="input" /></label>
  <label>Legendary <input type="number" min="0" id="tp-legendary" value="0" class="input" /></label>
  <label>Shiny <input type="number" min="0" id="tp-shiny" value="0" class="input" /></label>
</div>
<p class="hint">Déjalo en 0 para probabilidades reales. Si rellenas, debe sumar 10.</p>
```

**`admin.ts`** (`openTestPack`): lee los 5 inputs; si los 5 son 0, no incluye `counts` en el body (comportamiento random de siempre); si no, incluye `counts: {common, rare, epic, legendary, shiny}`.

`request()` cambia su rama de fallo para intentar parsear el body de error y exponerlo:

```ts
type RequestResult<T> = { ok: true; data: T } | { ok: false; status: number; error?: string };

async function request<T>(path: string, init?: RequestInit): Promise<RequestResult<T>> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    return { ok: false, status: res.status, error: body?.error };
  }
  return { ok: true, data: (await res.json()) as T };
}
```

`openTestPack` usa `result.error ?? "Error al abrir el sobre de prueba."` en vez del mensaje fijo actual.

## Testing

`test/lib/packs.test.ts`: `pickExactCards` devuelve exactamente N de cada rareza pedida + N shiny de cualquier rareza; lanza si se pide una rareza/shiny sin cartas disponibles en el catálogo filtrado.

`test/routes/admin.test.ts`: `POST /test-pack` con `counts` sumando 10 → `200`, la composición de `cards` devueltas coincide exactamente con lo pedido; suma ≠ 10 → `400`; contador > 0 para una rareza sin cartas en esa generación → `400` con el mensaje de `pickExactCards`.

## Out of scope

- Tamaño de sobre distinto de 10 cuando se fuerza composición.
- Elegir de qué rareza específica sale cada shiny (el shiny se elige entre todas las shinies de la generación, sin filtrar por rareza).
