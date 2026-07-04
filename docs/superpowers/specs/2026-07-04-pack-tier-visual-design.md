# Diferencia visual sobre gratis vs apoyo — Design

## Contexto

[[2026-07-04-pack-tiers-design]] introdujo el tier (`gratis`/`apoyo`) que determina las probabilidades del sobre, pero visualmente todos los sobres sin abrir se ven idénticos: `src/collection.ts` `renderPendingPacks` pinta siempre `<img class="pack-open-img" src="/pack.webp">`, sin mirar el tier. El usuario quiere poder distinguir a simple vista qué sobres pendientes son de apoyo.

No hay herramienta de generación de imágenes disponible, así que la diferencia se construye sobre el mismo `pack.webp` con CSS, reutilizando el lenguaje visual que ya usan las cartas raras/legendarias (borde de color + efecto "foil" animado) en vez de introducir un sistema nuevo.

## Alcance

Solo el icono de sobre sin abrir en "Sobres pendientes" (`collection.html`). Fuera de alcance: historial admin (ya muestra el tier como texto), overlay de stream (solo muestra cartas ya abiertas, nunca el sobre cerrado), sobre de prueba del panel admin (no pasa por esta pantalla).

## Backend

`worker/routes/collection.ts`, query de `pendingPacks` (ruta `GET /api/collection`):

```ts
const pendingPacks = await c.env.DB.prepare(
  "SELECT id, created_at AS createdAt, tier FROM packs WHERE user_id = ? AND opened_at IS NULL ORDER BY created_at"
)
```

`src/api.ts`:

```ts
export interface PendingPack {
  id: number;
  createdAt: string;
  tier: "gratis" | "apoyo";
}
```

## Frontend — `src/collection.ts`

Nueva función pura, testeable sin DOM:

```ts
export function shouldShowFoil(tier: PendingPack["tier"]): boolean {
  return tier === "apoyo";
}
```

En `renderPendingPacks`, para cada pack:
- Si `shouldShowFoil(pack.tier)` es `false` (gratis): se crea el `<img class="pack-open-img">` exactamente igual que hoy — cero cambios de DOM/CSS/comportamiento para sobres gratis.
- Si es `true` (apoyo): el mismo `<img>` se envuelve en un `<div class="pack-wrapper apoyo">` junto a un `<div class="pack-foil-shine"></div>` overlay. El listener de click, `animationDelay` de stagger, y la clase `opening` al abrir siguen aplicándose al `<img>` igual que ahora (el wrapper no intercepta ni cambia esa lógica).

## CSS — `src/style.css`

```css
.pack-wrapper { position: relative; display: inline-block; }

.pack-wrapper.apoyo .pack-open-img {
  border: 2px solid var(--gold);
  border-radius: 14px;
}

.pack-foil-shine {
  position: absolute;
  inset: 0;
  border-radius: 14px;
  pointer-events: none;
  background: linear-gradient(115deg, transparent 40%, rgba(255, 255, 255, 0.65) 50%, transparent 60%);
  background-size: 250% 250%;
  mix-blend-mode: overlay;
  animation: shimmer 2.6s linear infinite;
}

@keyframes shimmer {
  from { background-position: -200% 0; }
  to { background-position: 200% 0; }
}
```

(`shimmer` es la animación ya definida en el sistema de diseño de marca global — se declara aquí en `style.css` porque hoy no existe todavía en este proyecto en concreto.)

El borde dorado (`--gold`, ya definido en `style.css`, mismo tono que usan las cartas legendarias) da una marca estática visible incluso sin animación (screenshot, `prefers-reduced-motion`, etc.); el brillo es el plus animado encima.

No se sincroniza el shine con la animación `pack-idle` (bamboleo suave) que ya tiene `.pack-open-img` — al ser un overlay absoluto sobre un wrapper sin su propia animación, se queda ligeramente "quieto" mientras el sobre se bambolea debajo. Es un detalle menor y aceptable para no reescribir las reglas de hover/active existentes de `.pack-open-img`.

## Testing

- `src/collection.test.ts` (nuevo): `shouldShowFoil("apoyo")` → `true`; `shouldShowFoil("gratis")` → `false`.
- `test/routes/collection.test.ts`: `GET /api/collection` incluye `tier` en cada `pendingPacks[]`, con el valor correcto según el tier con el que se creó el pack.

## Fuera de alcance

- Nueva imagen de sobre (asset gráfico) específica para apoyo — se pidió explícitamente evitarlo, se resuelve con CSS sobre el asset existente.
- Sincronizar la animación de bamboleo (`pack-idle`) entre el sobre y el overlay de brillo.
- Aplicar la distinción visual al sobre de prueba del admin o a cualquier otra pantalla fuera de "Sobres pendientes".
