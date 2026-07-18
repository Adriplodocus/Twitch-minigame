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
4. Si `new_streak % 7 === 0` (milestone) → insertar **solo** el pack bonus: `INSERT INTO packs (user_id, source, tier) VALUES (?, 'daily_streak', 'apoyo')`. El sobre gratis normal (`source='daily'`) no se otorga ese día — el bonus lo sustituye, no se acumulan los dos.
5. Si no es milestone → insertar el pack normal de siempre: `INSERT INTO packs (user_id, source, tier) VALUES (?, 'daily', 'gratis')`.
6. Respuesta: `{ ok: true, streak: new_streak, milestone: boolean }`.

El insert anti-cheat en `daily_pack_claims` ya no va en batch con el insert del pack — se ejecuta solo, como gate. Solo tras confirmarlo con éxito se calcula la racha y se decide qué pack otorgar. Sigue sin haber condición de carrera nueva: ese insert único garantiza que como mucho una request por user/día llega a ejecutar el resto del bloque.

### `GET /api/daily-pack/status`

Pasa a devolver también `streak: current_streak` (0 si no hay fila), para pintar la barra al cargar la página antes de reclamar.

```ts
export function getDailyPackStatus(): Promise<{ claimed: boolean; streak: number }> { ... }
export function claimDailyPack(): Promise<{ ok: true; streak: number; milestone: boolean } | { error: string }> { ... }
```

### Frontend

Sin barra inline permanente sobre el FAB. En su lugar, un **popup modal** que se abre al pulsar `#daily-pack-btn`, tanto si el claim ocurre en ese click como si el sobre de hoy ya estaba reclamado (el botón deja de quedar `disabled` tras reclamar — sigue siendo clicable para consultar la racha, solo cambia el ícono a ✔ y el tooltip a "Ver tu racha").

Modal (reusa `.modal-overlay`/`.modal`, creado dinámicamente en `user-header.ts` como `openAlbumPickerModal` en `collection.ts`):

- Ícono grande de `Freepack.png`.
- "Racha: N días".
- **7 pips discretos** (círculos día 1–7, no barra continua): pips ≤ `streak_in_week` en `--pink`; el pip 7 lleva el ícono del sobre dentro y se ilumina en `--gold` al completarse (`streak_in_week === 7`). `streak_in_week = streak === 0 ? 0 : ((streak - 1) % 7) + 1`.
- Mensaje: "¡Racha de 7 días completada! Sobre apoyo extra 🎁" si `milestone`, si no "Vuelve mañana para seguir tu racha".
- Cierre con click fuera, Escape, o botón "Cerrar" (mismo patrón que `how-to-panel`).
- Si `milestone: true` → además se reusa el sistema de notificaciones existente (`notify()` / campana) para persistir el aviso.

### Styling (`src/style.css`)

`.streak-modal`: columna centrada. `.streak-pip`: círculo ~2rem, `--surface2` sin completar, `rgba(255,86,180,0.20)` + borde `--pink` al completarse; el pip meta (`.goal`) usa `--gold` en vez de `--pink` al completarse. `.daily-pack-img-btn.claimed` ya no lleva `cursor: not-allowed` (sigue siendo clicable).

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
