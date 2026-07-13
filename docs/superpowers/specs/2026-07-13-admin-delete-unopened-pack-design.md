# Admin: eliminar sobres sin abrir

## Motivo

EventSub disparaba `channel.subscribe` y `channel.subscription.message` para la misma sub nueva cuando el viewer comparte mensaje al suscribirse, duplicando el sobre de apoyo (ver fix en `worker/routes/webhook.ts`, `cumulative_months === 1` skip). El admin no tenía forma de corregir sobres ya otorgados por error sin tocar la base de datos manualmente. Se necesita una vía en el panel para borrar sobres entregados que el usuario aún no ha abierto.

## Alcance

Solo sobres reales (`is_test = 0`) sin abrir (`opened_at IS NULL`) pueden borrarse. Sobres abiertos no se tocan (ya generaron cartas). Sin restricción de antigüedad.

## Backend

`worker/routes/admin.ts`:
- `admin.delete("/packs/:id", requireAdmin, ...)`
  - Busca el pack por id.
  - 404 si no existe.
  - 409 si `opened_at` no es null o `is_test = 1`.
  - `DELETE FROM packs WHERE id = ?` si pasa validación.
  - Devuelve `{ ok: true }`.
- `/history`: añade `opened_at AS openedAt` al SELECT existente para que el frontend sepa qué filas son borrables.

## Frontend

`src/admin.ts`:
- `HistoryRow` gana campo `openedAt: string | null`.
- `renderHistory`: columna extra con botón "Eliminar" solo cuando `h.openedAt === null`.
- Click → `confirm()` con nombre de usuario → `DELETE /api/admin/packs/:id` → recarga historial (`loadHistory()`).

## Testing

- Test worker (`vitest.workers.config.ts`) para el endpoint: borra pack sin abrir (200), rechaza pack abierto (409), rechaza pack de test (409), rechaza id inexistente (404).
