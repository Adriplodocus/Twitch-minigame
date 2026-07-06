# Marketplace

Depende de [Sistema de notificaciones](./2026-07-07-notifications-design.md) — debe implementarse antes (`notify()` se usa al aceptar una oferta).

## Problem

El sistema de trade actual (`worker/routes/trade.ts`) requiere conocer el username exacto del otro usuario y negociar 1:1. No funciona bien como mercado abierto: nadie descubre qué ofrecen otros usuarios. Se añade un marketplace donde cualquier usuario publica una oferta pública (demanda 1 cromo, ofrece varios) que cualquier otro puede aceptar sin negociación previa.

## Design

### Modelo de datos — `migrations/0021_marketplace.sql`

```sql
ALTER TABLE user_cards ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0;

CREATE TABLE marketplace_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id TEXT NOT NULL REFERENCES users(twitch_id),
  demand_card_id TEXT NOT NULL REFERENCES cards(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'accepted')),
  acceptor_id TEXT REFERENCES users(twitch_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TEXT
);
CREATE INDEX idx_marketplace_offers_creator ON marketplace_offers(creator_id);
CREATE INDEX idx_marketplace_offers_status ON marketplace_offers(status, created_at DESC);

CREATE TABLE marketplace_offer_items (
  offer_id INTEGER NOT NULL REFERENCES marketplace_offers(id),
  card_id TEXT NOT NULL REFERENCES cards(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
```

`demand_card_id` es siempre cantidad 1 (no hay tabla de items para la demanda). Las cartas ofrecidas sí son multi-carta/cantidad, en `marketplace_offer_items`.

### Reserva de cartas (escrow) — cruzado con trade

`user_cards.reserved` = unidades comprometidas en ofertas de marketplace activas del propio usuario. **Disponible real = `quantity - reserved`**, y este cálculo se usa en todos los sitios que hoy miran `quantity` a secas para decidir si el usuario "tiene" una carta para comprometerla en otro sitio:

- `ownedQuantity()` en `trade.ts` pasa a restar `reserved`.
- El nuevo `marketplace.ts` usa el mismo cálculo al crear/cancelar/aceptar.
- Colección y buscadores (trade, marketplace) siguen mostrando solo el disponible, sin desglose "reservado" visible (decidido en brainstorming — simplicidad, no añade UI nueva en pantallas ya existentes).

Ciclo de vida de `reserved` por carta ofrecida:
- Crear oferta → `reserved += qty`.
- Cancelar (activa) o expirar (activa, 7 días) → `reserved -= qty` (libera).
- Aceptar → `reserved -= qty` y `quantity -= qty` a la vez (se consume, no solo se libera).

El cromo demandado nunca se reserva (nadie sabe quién va a aceptar ni cuándo); se comprueba y transfiere atómicamente en el momento de aceptar.

### Creación de oferta

Página nueva `marketplace.html` / `src/marketplace.ts`. Link "Marketplace" añadido al nav de `collection.html`, `trade.html`, `album.html`, `offers.html`.

Vista "Mis ofertas" tiene botón "Crear oferta" → modal wizard con barra de progreso (3 pasos):

1. **Demanda**: buscador contra el catálogo completo del juego (`GET /api/catalog?q=`, busca en `cards`, no en la colección del usuario — se puede demandar cualquier Pokémon exista o no en tu colección). Selección única, sin cantidad (siempre 1).
2. **Oferta**: buscador contra la colección propia del usuario. Cada resultado lleva un input numérico (mín 1, máx = disponible = `quantity - reserved`). Grid a la derecha refleja en tiempo real lo añadido, renderizado con `renderCardHtml` (`src/card.ts`) para mantener foil/shiny/estilo consistente con el resto del sitio. Se requiere ≥1 carta ofrecida para avanzar.
3. **Confirmación**: preview con la misma estructura visual que la tarjeta final (Demanda / Ofrece). Botón "Crear oferta" → `POST /api/marketplace/offers { demandCardId, offerItems: [{ cardId, quantity }] }`.

Validación backend al crear:
- Nº de ofertas del creador con `status IN ('active','accepted')` < 4, si no → 409 "Tienes el máximo de ofertas, elimina alguna antes de crear otra".
- Cada `offerItem`: disponible (`quantity - reserved`) ≥ `qty` pedida, si no → 409.
- Inserta `marketplace_offers` + `marketplace_offer_items`, incrementa `reserved` por cada item.

### Listado público

`GET /api/marketplace/offers?page=&demandQuery=&offerQuery=`:
- `status = 'active'` y `creator_id != self` (las propias solo se ven en "Mis ofertas", nunca mezcladas en el listado público).
- Orden `created_at DESC`, paginado de 6 en 6 (grid 2×3).
- `demandQuery` / `offerQuery` opcionales e independientes (dos inputs de filtro separados, combinables con AND): `demandQuery` filtra por nombre del cromo demandado, `offerQuery` por nombre de cualquiera de los cromos ofrecidos.

Estructura de cada tarjeta:
- Esquina sup. izquierda: "Oferta de {username}".
- Esquina sup. derecha: fecha de publicación `dd/mm/aaaa`.
- Izquierda: label "Demanda" + cromo (con overlay "Tienes X", disponible del usuario que mira).
- Derecha: label "Ofrece" + grid de cromos (mismo overlay "Tienes X" por cada uno).
- "Tienes X" se calcula server-side (join contra `user_cards` del viewer autenticado) para mantener el endpoint autosuficiente y consistente con la paginación.
- Botón "Aceptar": deshabilitado (con `title`) si "Tienes 0" del cromo demandado. Habilitado → abre modal de confirmación → `POST /api/marketplace/offers/:id/accept`.

### Aceptar oferta

1. `UPDATE marketplace_offers SET status = 'accepted', acceptor_id = ?, accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'` vía `.run()` (no `.batch()`) — si `meta.changes === 0`, la oferta ya no está disponible (aceptada/cancelada por otro camino mientras tanto) → 409 "Oferta ya no disponible". Este guard atómico cierra la ventana de doble-accept que el `trade.ts` actual no tiene.
2. Si el guard pasa: comprobar que el aceptador tiene ≥1 disponible del `demand_card_id`. Si no (su colección cambió entre que cargó la página y pulsó Aceptar) → revertir el update del paso 1 (`status = 'active', acceptor_id = NULL, accepted_at = NULL`) y devolver 409.
3. Validación defensiva: `acceptorId !== creatorId` → 400 (el frontend ya excluye las propias del listado, esto es cinturón y tirantes).
4. Batch de transferencia: por cada `marketplace_offer_items` → `creator.quantity -= qty`, `creator.reserved -= qty`, `acceptor.quantity += qty` (upsert). Más `acceptor.quantity -= 1` del `demand_card_id`, `creator.quantity += 1` (upsert).
5. `notify(env, creator_id, "Una oferta tuya ha sido aceptada", "/marketplace.html?tab=mine")`.

Al aceptarse, la oferta desaparece del listado público inmediatamente (deja de cumplir `status = 'active'`).

### Mis ofertas

`GET /api/marketplace/offers/mine`: todas las del usuario (`active` + `accepted`), sin paginar (tope natural de 4), grid de 2 columnas (2 ofertas por fila).

- Activa → botón "Cancelar": libera `reserved` de sus items, borra offer + items.
- Aceptada → botón "Eliminar": borra offer + items sin tocar cartas (el intercambio ya ocurrió, esto solo limpia el registro). Distinto label de "Cancelar" para no sugerir que revierte el intercambio.

### Expiración automática

Sweep lazy (mismo patrón que `expireStaleOffers` en `trade.ts`), ejecutado al inicio de `GET /offers`, `GET /offers/mine` y `POST .../accept`:
- Activas con `created_at <= now - 7 días` → libera `reserved` de sus items, borra offer + items. Desaparecen sin dejar rastro (no hay estado "Expirada" — decidido en brainstorming).
- Aceptadas con `accepted_at <= now - 7 días` → borra offer + items directamente, nada que liberar.

### Fuera de alcance

- Estado "Expirada" visible — las activas vencidas se borran silenciosamente.
- Cron real de Cloudflare — el sweep lazy en cada request es suficiente (mismo criterio que trade).
- Cantidad > 1 en el cromo demandado — siempre exactamente 1.
- Mostrar desglose "reservado vs total" en colección/buscadores — solo se ve el disponible.
- Migrar el dot-badge de trades al nuevo sistema de notificaciones (cubierto en el spec de notificaciones).
- Historial de quién aceptó una oferta pasada (más allá de `acceptor_id` en BD, no hay UI para consultarlo).

## Testing

`vitest.workers.config.ts`:
- Crear oferta reserva cartas (`reserved` sube) y `ownedQuantity()` de `trade.ts` refleja el bloqueo.
- Máximo 4 ofertas por creador (activas + aceptadas cuentan); cancelar/eliminar libera el slot.
- Aceptar transfiere cartas correctamente (ambos lados), libera `reserved` del creador, dispara `notify()`.
- Doble-accept concurrente: segunda llamada recibe 409 por el guard atómico.
- Sweep expira activas a los 7 días liberando `reserved`; expira aceptadas a los 7 días sin tocar cartas.
- Filtro por `demandQuery`/`offerQuery` (independientes y combinados), paginación 2×3, exclusión de ofertas propias del listado público.
- Botón Aceptar deshabilitado cuando el viewer no tiene el cromo demandado (dato "Tienes 0" desde el endpoint).

Manual: flujo wizard completo (3 pasos), tarjetas se ven bien (foil/shiny vía `renderCardHtml`), overlay "Tienes X" correcto en demanda y oferta, notificación aparece tras aceptar y su link lleva a "Mis ofertas".
