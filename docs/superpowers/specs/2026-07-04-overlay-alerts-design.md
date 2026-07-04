# Overlay Alerts — Design

## Contexto

Se quiere que al abrir un sobre, el usuario pueda elegir mostrar lo que sacó en el overlay del stream (OBS Browser Source), para dar hype en directo. Debe ser opt-in explícito por apertura, no una preferencia global — y no debe usar infraestructura de pago (nada de KV ni Durable Objects), reusando D1 como el resto del proyecto.

## Cambios de datos

Migración nueva (`migrations/0010_pack_broadcast.sql`):

```sql
ALTER TABLE packs ADD COLUMN broadcast_at TEXT;
```

`NULL` por defecto = nunca mostrado en stream. Se rellena cuando el usuario decide mostrarlo.

## Flujo de usuario

En el modal de reveal de sobre (`src/collection.ts`), donde hoy hay un botón de cerrar, pasan a haber dos:

- **"Cerrar"** — comportamiento actual, sin más.
- **"Cerrar y mostrar en stream"** — llama al endpoint de broadcast y luego cierra el modal.

## Endpoints nuevos

**`POST /api/collection/packs/:id/broadcast`** (requireAuth)
- Verifica que el pack pertenece al usuario autenticado y que ya está abierto (`opened_at IS NOT NULL`); si no, 404/409 como el resto de rutas de packs.
- `UPDATE packs SET broadcast_at = CURRENT_TIMESTAMP WHERE id = ?`.
- Idempotente: si se llama dos veces, simplemente actualiza el timestamp.

**`GET /api/overlay/events?since=<cursor>`** (público, sin auth)
- Sin auth a propósito: `overlay.html` corre como Browser Source dentro de OBS, no hay sesión de usuario ahí. Los datos expuestos son exactamente los que el usuario decidió mostrar en directo (opt-in), no hay filtración de datos privados.
- `cursor` = último `broadcast_at` visto por el cliente (ISO string), o vacío en la primera carga (en ese caso, devolver vacío para no hacer replay de historial viejo al abrir OBS).
- Query: packs con `broadcast_at IS NOT NULL AND broadcast_at > ?`, join con `users` (username, avatar) y `pack_cards` + catálogo (para nombre/rareza/categoría/shiny de cada carta), `ORDER BY broadcast_at ASC LIMIT 20`.
- Respuesta: lista de eventos `{ packId, username, avatarUrl, broadcastAt, cards: [{ id, name, rarity, category, shiny }] }`.
- Sin filtro de rareza por ahora — se devuelven todas las cartas del pack. Preparado para que el día que se quiera filtrar (ej. solo epic+/legendary/shiny) sea un filtro en el cliente (`overlay.ts`) sobre el array `cards`, sin tocar el endpoint ni el schema.

## Overlay page

`overlay.html` + `src/overlay.ts`:
- Sin login — pensado para pegarse como URL de Browser Source en OBS.
- Polling cada ~4s a `/api/overlay/events?since=<cursor>`, cursor guardado en memoria (empieza vacío, se actualiza al `broadcastAt` del último evento recibido).
- Por cada evento nuevo: encola una alerta (avatar + username + cartas), reutilizando los estilos de rarity VFX ya existentes (`src/card-tilt.ts` / estilos de rareza en `src/style.css`) para el color/glow de cada carta.
- Las alertas se muestran una detrás de otra (cola), cada una con auto-dismiss tras unos segundos, para no solapar si llegan varias seguidas.
- Fondo transparente (para Browser Source), sin interacción — es solo display.

## Error handling

- Si `/broadcast` falla (red, servidor), el modal muestra un error breve y no cierra — el usuario puede reintentar o usar "Cerrar" normal.
- Si el polling de `overlay.ts` falla una vez, se ignora y se reintenta en el siguiente ciclo (no hay reconexión compleja porque no es un socket, es polling stateless).

## Testing

- Test de `/packs/:id/broadcast`: 404 si el pack no es del usuario, 409 si no está abierto, ok si es válido, columna se actualiza.
- Test de `/api/overlay/events`: devuelve solo packs con `broadcast_at` seteado y posterior al cursor; respeta el orden y el límite; sin auth requerida.
- Manual: abrir un sobre, click "mostrar en stream", verificar que aparece en `overlay.html` abierto en otra pestaña.

## Fuera de alcance

- Filtro por rareza (queda preparado, no implementado).
- Preferencia global de usuario / settings page.
- WebSockets o Durable Objects.
