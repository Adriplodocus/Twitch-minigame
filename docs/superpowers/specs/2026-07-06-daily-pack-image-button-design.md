# Botón de sobre diario con imagen Freepack

## Problem

El FAB de sobre diario actual (`.btn-daily-pack`) es un pill de texto. Se sustituye por la imagen `public/Freepack.png` (444x444), manteniendo el mismo flujo de reclamo (`getDailyPackStatus` / `claimDailyPack`).

## Design

### HTML

En las 4 páginas viewer (`collection.html`, `trade.html`, `offers.html`, `album.html`), el bloque `.daily-pack-fab` pasa de:

```html
<button class="btn-daily-pack" id="daily-pack-btn" type="button">🎁 Reclama tu sobre diario</button>
```

a:

```html
<button class="daily-pack-img-btn" id="daily-pack-btn" type="button" aria-label="Reclama tu sobre diario">
  <img src="/Freepack.png" alt="" />
  <span class="daily-pack-check" aria-hidden="true">✔</span>
  <span class="daily-pack-tooltip">Reclama tu sobre diario</span>
</button>
```

### CSS (`src/style.css`)

Reemplaza las reglas `.btn-daily-pack*` por:

- `.daily-pack-img-btn`: círculo ~76px (desktop) / ~60px (mobile, `max-width: 480px`), `position: relative`, `img` a `object-fit: cover`, `border-radius: 50%`, borde `1px solid rgba(255,86,180,0.4)`, glow pink en `:hover:not(.claimed)` (transform + box-shadow, mismo patrón que el pill actual).
- `.daily-pack-check`: badge circular pequeño (~1.4rem), fondo `#22C55E`, posicionado `position: absolute; top: -4px; right: -4px;`, `display: none` por defecto.
- `.daily-pack-img-btn.claimed .daily-pack-check { display: flex; align-items:center; justify-content:center; }`
- `.daily-pack-img-btn.claimed`: `cursor: not-allowed`, sin glow en hover, imagen con opacidad reducida (~0.85) para indicar estado inactivo.
- `.daily-pack-tooltip`: `position: absolute; left: calc(100% + 0.75rem); top: 50%; transform: translateY(-50%);` panel tipo `.info-tooltip` (superficie, borde, sombra), `display: none` por defecto, `white-space: nowrap`.
- Mostrar tooltip solo con hover real y solo si no reclamado: `@media (hover: hover) and (pointer: fine) { .daily-pack-img-btn:not(.claimed):hover .daily-pack-tooltip { display: block; } }`. En mobile (sin hover) el tooltip nunca se muestra.

### JS (`src/user-header.ts`)

`markClaimed()` cambia de (disabled + textContent) a:

```ts
const markClaimed = () => {
  dailyPackBtn.disabled = true;
  dailyPackBtn.classList.add("claimed");
};
```

Resto del flujo (`getDailyPackStatus().then(...)`, click handler, manejo de error/409) no cambia.

## Testing

`src/daily-pack-button.test.ts` ya verifica `id="daily-pack-btn"` presente/ausente por página — sigue pasando sin cambios (el id no cambia). No se añaden tests nuevos: es un cambio puramente visual/markup, sin nueva lógica de negocio.

## Out of scope

- No countdown ni animación adicional de apertura.
- No tooltip táctil en mobile (decisión explícita: solo hover real).
