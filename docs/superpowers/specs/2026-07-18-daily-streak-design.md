# Racha del sobre diario

## Problem

El sobre diario (`daily-pack.ts`, `0017`/`0018`) da un sobre gratis una vez al día, pero no premia volver *consecutivamente*. Objetivo: retención diaria — incentivar que el viewer reclame cada día seguido, con un bonus visible al completar una semana.

## Design

### Schema

Nueva migración, tabla dedicada (mismo patrón que `daily_pack_claims`):

```sql
CREATE TABLE daily_streaks (
  user_id TEXT PRIMARY KEY REFERENCES users(twitch_id),
  current_streak INTEGER NOT NULL DEFAULT 0,
  last_claim_date TEXT
);
```

Rebuild de `packs` (mismo patrón que `0017_daily_pack_source.sql`) para añadir `'daily_streak'` al `CHECK` de `source`:

```sql
source TEXT NOT NULL DEFAULT 'reward' CHECK (source IN ('reward', 'admin', 'bits', 'sub', 'gift_sub', 'paypal', 'paypal_manual', 'daily', 'daily_streak'))
```

### Lógica de racha (`POST /api/daily-pack/claim`)

Tras el insert existente en `daily_pack_claims` (que sigue siendo el único gate anti-doble-reclamo — no se toca):

1. Leer `daily_streaks` del user (`current_streak=0, last_claim_date=null` si no existe fila).
2. `last_claim_date === date('now','-1 day')` → `new_streak = current_streak + 1`; en cualquier otro caso (primera vez, o gap de días) → `new_streak = 1`.
3. Upsert `daily_streaks` (`INSERT ... ON CONFLICT(user_id) DO UPDATE`) con `new_streak` y `claim_date = date('now')`.
4. Si `new_streak % 7 === 0` → insertar pack extra: `INSERT INTO packs (user_id, source, tier) VALUES (?, 'daily_streak', 'apoyo')`.
5. Respuesta: `{ ok: true, streak: new_streak, milestone: boolean }`.

Sin condición de carrera nueva: el insert único en `daily_pack_claims` ya garantiza que como mucho una request por user/día llega a ejecutar este bloque.

### `GET /api/daily-pack/status`

Pasa a devolver también `streak: current_streak` (0 si no hay fila), para pintar la barra al cargar la página antes de reclamar.

```ts
export function getDailyPackStatus(): Promise<{ claimed: boolean; streak: number }> { ... }
export function claimDailyPack(): Promise<{ ok: true; streak: number; milestone: boolean } | { error: string }> { ... }
```

### Frontend

Nuevo elemento sobre `.daily-pack-fab` (mismo contenedor `position: fixed`), en las 4 páginas viewer:

```html
<div class="daily-streak-bar" id="daily-streak-bar">
  <div class="daily-streak-fill" id="daily-streak-fill"></div>
  <img class="daily-streak-goal" src="/Freepack.png" alt="" />
</div>
```

- `streak_in_week = streak === 0 ? 0 : ((streak - 1) % 7) + 1` (posición 1–7 dentro del ciclo actual).
- `daily-streak-fill`: `width: calc(streak_in_week / 7 * 100%)`, `transition: width 0.3s`, fondo `--pink`.
- `daily-streak-goal`: ícono `Freepack.png` pequeño al final de la barra; recibe clase `.pack-foil-shine` (shimmer ya usado para tier `apoyo`) solo cuando `streak_in_week === 7` (bonus alcanzado ese día); opacidad reducida el resto del tiempo.
- `user-header.ts`: `getDailyPackStatus()` pinta la barra al cargar (`streak`). Click handler usa `streak`/`milestone` de la respuesta de `claimDailyPack()` para actualizar la barra.
- Si `milestone: true` → reusar sistema de notificaciones existente (`notify()` / panel de campana) para avisar "¡Racha de 7 días! Sobre apoyo extra 🎁" — no se construye UI de toast nueva.

### Styling (`src/style.css`)

`.daily-streak-bar`: barra fina (~4px alto) posicionada justo encima de `.daily-pack-fab`, ancho igual al botón, `border-radius: 100px`, fondo `var(--surface2)`. `.daily-streak-fill` con transición de ancho. `.daily-streak-goal`: ~16px, `position: absolute`, extremo derecho de la barra.

## Testing

Worker (`vitest.workers.config.ts`, extiende `test/routes/daily-pack.test.ts`):

- Claim sin racha previa → `streak=1`, sin pack bonus, `milestone:false`.
- Claim con `last_claim_date` = ayer (seed manual en `daily_streaks`) → `streak` incrementa desde el valor previo.
- Claim con gap (`last_claim_date` = anteayer o antes) → `streak` resetea a `1`.
- `new_streak=7` → se crea pack extra `source='daily_streak', tier='apoyo'`, `milestone:true`.
- `new_streak=14` (segundo ciclo) → también dispara bonus.
- `GET /status` refleja `streak` correcto antes y después de reclamar.

Frontend (`vitest.config.ts`): extender `daily-pack-button.test.ts` — `id="daily-streak-bar"` presente en las 4 páginas viewer, ausente en `admin.html`.

## Out of scope

- No hay tope máximo de racha ni recompensa distinta más allá del ciclo de 7 días (el bonus se repite igual en cada múltiplo de 7).
- No hay recuperación de racha perdida (sin gracia de 1 día — decisión explícita).
- No previene multi-cuenta — mismo alcance que `daily-pack-design.md`.
- No se crea un asset `Apoyopack.png` nuevo — reusa `Freepack.png` + `.pack-foil-shine`.
