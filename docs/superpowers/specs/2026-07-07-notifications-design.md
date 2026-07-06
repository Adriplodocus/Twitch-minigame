# Sistema de notificaciones

## Problem

No existe un canal genérico para avisar a un usuario de eventos que le conciernen. Lo único parecido hoy es el dot-badge de `trade.ts` (`/api/trade/offers/pending-count`), pero es específico de trades y no lleva mensaje de texto. El marketplace (próximo spec) necesita avisar "Una oferta tuya ha sido aceptada", y se prevé que otros subsistemas futuros (trades, grants de admin, etc.) quieran lo mismo. Se construye ahora como infraestructura reusable, independiente del marketplace.

## Design

### Schema — `migrations/0020_notifications.sql`

```sql
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  message TEXT NOT NULL,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
```

`link` es opcional (NULL si la notificación es solo informativa).

### Helper de producción — `worker/lib/notifications.ts`

```ts
export async function notify(env: Env, userId: string, message: string, link?: string): Promise<void>
```

Inserta la fila y, en la misma llamada, purga el excedente por encima de 20 para ese usuario:

```sql
DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
  SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20
)
```

Cualquier subsistema futuro (marketplace, trade, admin) llama a `notify()` directamente desde su propio route handler — es una función interna del Worker, no un endpoint HTTP; no hace falta que los productores pasen por `/api/notifications`.

### Rutas — `worker/routes/notifications.ts`, montado en `/api/notifications`, `requireAuth`

- `GET /api/notifications/unread` → `{ unread: boolean }`. Ligero, no marca nada como leído. Lo usa el header en cada carga de página para pintar (o no) el punto.
- `GET /api/notifications` → lista de hasta 20 (`id, message, link, read: boolean, createdAt`), orden desc por fecha. Como side-effect, marca todas las no leídas de ese usuario como leídas (abrir el tooltip = consultar este endpoint = leer, tal como se pidió). No hace falta un endpoint `POST .../read` separado.

### Frontend

Módulo nuevo `src/notifications.ts`, invocado desde `initUserHeader()` (`src/user-header.ts`). Se inserta un botón `.icon-btn` con icono de campana justo antes de `#user-name` (orden final en `.page-header-user`: mute, donate, avatar, **bell**, username, logout) — queda a la izquierda del username tal como se pidió.

- Al cargar la página: `GET /notifications/unread`; si `true`, añade el mismo `.notif-dot` que ya usa el link de ofertas de trade (reuso de clase existente).
- Click en la campana: toggle de un panel desplegable (`.notif-panel`), copiando el patrón ya existente de `#how-to-panel` en el propio `user-header.ts` (click fuera o `Esc` cierra, `aria-expanded`).
- Al abrir el panel: `GET /notifications` (marca leídas server-side), pinta la lista, quita el `.notif-dot`. Cada item es clicable solo si trae `link` (navega con `window.location.href = link`); sin link, el item es puramente texto.
- Sin polling en segundo plano — igual que el resto de indicadores del header (daily pack, pending offer count), se consulta una vez por carga de página.

### Fuera de alcance

- No se toca el dot-badge de trades (`pending-count`) — sigue siendo su propio endpoint, sin migrar.
- Sin distinción visual leído/no-leído dentro de la lista una vez abierta — todo se marca leído al abrir; solo importa el punto pre-apertura.
- Sin límite temporal de retención — solo el tope duro de 20 por overflow (los más antiguos se borran permanentemente al insertar el 21º).
- Sin UI de admin para mandar notificaciones arbitrarias — solo llamadas programáticas a `notify()` desde otros subsistemas.
- Sin paginación — el tope de 20 hace innecesario paginar la lista del tooltip.

## Testing

- `vitest.workers.config.ts`: `notify()` purga por encima de 20; `GET /unread` refleja estado antes de abrir; `GET /notifications` marca como leídas y `GET /unread` pasa a `false` después.
- Manual: invocar `notify()` desde un punto temporal (o esperar a la integración con marketplace), confirmar que aparece el punto, que abrir el panel lo quita, y que el click en un item con link navega.
