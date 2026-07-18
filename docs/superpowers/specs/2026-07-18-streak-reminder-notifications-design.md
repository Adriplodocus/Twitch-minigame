# Notificaciones proactivas del sobre diario / racha

## Problem

El sobre diario y la racha (`daily-pack.ts`, `daily_streaks`) solo se ven si el viewer entra a la app por su cuenta. No hay ningún empujón proactivo que le recuerde volver. Se añaden dos recordatorios in-app (misma campana de notificaciones ya existente) para aumentar el tráfico diario:

- "¡Sobre diario disponible! Canjéalo para mantener tu racha." — a todos los usuarios registrados, cuando el sobre del día se vuelve disponible.
- "Estás a punto de perder tu racha. Canjea el sobre diario para mantenerla." — solo a quienes tienen racha activa y aún no han reclamado hoy, poco antes de que expire el día.

## Design

### Trigger: Cloudflare Cron Triggers

`wrangler.jsonc` añade:

```jsonc
"triggers": {
  "crons": ["0 0 * * *", "0 21 * * *"]
}
```

- `0 0 * * *` (00:00 UTC): coincide con el reset diario (`date('now')` en `daily-pack.ts` usa UTC). Dispara el aviso de "sobre disponible".
- `0 21 * * *` (21:00 UTC, 3h antes del reset): dispara el aviso de "racha en riesgo".

### `worker/scheduled.ts` (nuevo)

```ts
import type { Env } from "./types";
import { notify } from "./lib/notifications";

export async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  if (event.cron === "0 0 * * *") {
    const { results } = await env.DB.prepare("SELECT twitch_id FROM users").all<{ twitch_id: string }>();
    for (const { twitch_id } of results) {
      await notify(env, twitch_id, "¡Sobre diario disponible! Canjéalo para mantener tu racha.", "/collection.html");
    }
    return;
  }

  if (event.cron === "0 21 * * *") {
    const { results } = await env.DB.prepare(
      `SELECT user_id FROM daily_streaks
       WHERE current_streak > 0
       AND NOT EXISTS (
         SELECT 1 FROM daily_pack_claims
         WHERE daily_pack_claims.user_id = daily_streaks.user_id AND claim_date = date('now')
       )`
    ).all<{ user_id: string }>();
    for (const { user_id } of results) {
      await notify(env, user_id, "Estás a punto de perder tu racha. Canjea el sobre diario para mantenerla.", "/collection.html");
    }
    return;
  }
}
```

### `worker/index.ts`

Cambia el export por defecto para añadir el handler `scheduled` junto al `fetch` de Hono:

```ts
import { handleScheduled } from "./scheduled";
// ...
export default { fetch: app.fetch, scheduled: handleScheduled };
```

(antes era `export default app` — `app.fetch` es el mismo handler, solo se expone junto a `scheduled`.)

### Sin deduplicación adicional

El cron corre una vez al día por diseño (no hay lectura-antes-de-escribir, no hay ventana de carrera que gestionar). Si Cloudflare reintentase raramente el mismo cron, como mucho se duplica una notificación — mismo nivel de tolerancia que el resto de usos de `notify()` en la app (p.ej. el milestone de racha en `daily-pack.ts`).

## Testing

`vitest.workers.config.ts` (Miniflare soporta invocar `scheduled` directamente vía `worker.scheduled({ cron: "..." }, env, ctx)` o importando `handleScheduled` y llamándolo con un `event` simulado `{ cron: "..." }`):

- Cron `"0 0 * * *"` con 2 usuarios → cada uno recibe una notificación con el mensaje de "sobre disponible".
- Cron `"0 21 * * *"`: usuario con `current_streak > 0` y sin claim hoy → recibe notificación de racha en riesgo.
- Mismo cron: usuario con `current_streak > 0` pero que YA reclamó hoy → no recibe notificación.
- Mismo cron: usuario con `current_streak = 0` → no recibe notificación.
- Cron desconocido → no crea ninguna notificación (no-op).

## Out of scope

- No hay canal fuera de la app (sin email, sin push del navegador, sin mensaje de bot en el chat de Twitch) — reusa la campana in-app existente, visible la próxima vez que el usuario cargue la página.
- No hay deduplicación explícita contra reintentos de Cloudflare.
- No se filtra por zona horaria del usuario — todos los horarios son UTC fijos, iguales para todos.
