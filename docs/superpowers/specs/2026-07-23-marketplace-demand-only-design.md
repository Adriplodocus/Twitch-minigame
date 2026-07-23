# Marketplace: solo demanda, respuesta libre

Sustituye el diseño de [Marketplace](./2026-07-07-marketplace-design.md). El marketplace actual obliga al creador a definir de antemano qué ofrece (`marketplace_offer_items`), y cualquiera acepta ese bundle tal cual, sin negociación. Se reemplaza por: el creador (A) solo publica qué cromo quiere; quien responda (B) elige libremente qué cromos de la colección de A quiere a cambio, igual que un trade normal — A acepta o rechaza esa propuesta en `offers.html` como ya hace hoy con trade.

## Problem

El marketplace actual resuelve "tengo esto, quiero aquello, que lo acepte quien quiera" sin negociación. No resuelve el caso "quiero este cromo, y a cambio pido lo que me interese de la colección de quien me lo dé" — que es exactamente lo que ya hace `trade.ts` (constructor libre + accept/decline), solo que ahí hay que conocer el username exacto y no hay forma de anunciar públicamente "busco X".

## Diseño

### Qué se elimina del marketplace actual

- Paso "Oferta" y "Confirmación" del wizard de creación (ya no hay bundle que definir).
- Accept directo de marketplace (`POST /api/marketplace/offers/:id/accept`) y toda la lógica de escrow que lo soportaba (reserva de cartas del creador al crear la oferta).
- Filtro `offerQuery` en el listado público (ya no hay cromos ofrecidos que buscar).
- Vista de ofertas "aceptadas" dentro de "Mis ofertas" del marketplace — al aceptarse una respuesta, la demanda se borra inmediatamente; el registro del intercambio vive de aquí en adelante en `offers.html` (aceptada), igual que cualquier trade.

`marketplace_offers`, `marketplace_offer_items`, `user_cards.reserved` no se borran a nivel de esquema (evita una migración destructiva sobre D1 en producción); simplemente el código nuevo deja de escribir en `marketplace_offer_items` y en `reserved`. `marketplace_offers` se reutiliza con solo 3 columnas relevantes (`creator_id`, `demand_card_id`, `created_at`); `status`/`acceptor_id`/`accepted_at` quedan sin usar (siempre su valor por defecto).

### Modelo de datos — `migrations/0025_marketplace_demand_response.sql`

```sql
ALTER TABLE trade_offers ADD COLUMN marketplace_demand_id INTEGER REFERENCES marketplace_offers(id);
CREATE INDEX idx_trade_offers_marketplace_demand ON trade_offers(marketplace_demand_id);
```

Único cambio de esquema: un trade offer creado como respuesta a una demanda queda enlazado a ella. `NULL` para cualquier trade offer normal (creado a mano vía `trade.html?with=`).

### Publicar una demanda

`marketplace.html`, botón "Crear demanda" → modal de un solo paso (ya no wizard de 3): el buscador de catálogo completo que hoy es el paso 1 (`GET /api/catalog?q=`, `renderCardHtml` para consistencia visual) se reutiliza tal cual. Selección única → botón "Crear demanda" → `POST /api/marketplace/offers { demandCardId }`.

Validación backend:
- Nº de demandas activas del creador < 4, si no → 409 "Tienes el máximo de demandas, elimina alguna antes de crear otra" (mismo tope que el marketplace actual).
- `demandCardId` debe existir en `cards`.
- Inserta fila en `marketplace_offers` (sin items).

### Listado público

`GET /api/marketplace/offers?page=&demandQuery=`:
- `creator_id != self` (las propias solo en "Mis demandas").
- Orden `created_at DESC`, paginado 6 en 6 (grid 2×3), igual que hoy.
- `demandQuery` filtra por nombre del cromo demandado (se elimina `offerQuery`).

Estructura de cada tarjeta (más simple que la actual, ya no hay grid de "ofrece"):
- Esquina sup. izquierda: "Demanda de {username}".
- Esquina sup. derecha: fecha `dd/mm/aaaa`.
- Centro: el cromo demandado (`renderCardHtml`) + overlay "Tienes X" — cantidad disponible del **viewer** (quien mira), no del creador. Se reutiliza el mismo cálculo servidor que ya existe (`quantity - reserved` del viewer para ese `card_id`).
- Botón "Responder": deshabilitado (con `title`) si "Tienes 0" — si el viewer no tiene el cromo demandado, no puede fulfillarlo. Habilitado → navega a `trade.html?demandId={id}`.

### Responder a una demanda (reutiliza trade.html)

`trade.html` gana un modo de entrada nuevo: `?demandId=123` (alternativa a `?with=username` para el flujo manual existente, que se mantiene intacto).

Al detectar `demandId` en `init()`:
1. `GET /api/marketplace/offers/:id` (nuevo endpoint público, solo lectura) → `{ creatorUsername, cardId, name, rarity, imagePath }` o 404 si la demanda ya no existe (aceptada/cancelada/expirada mientras tanto) → `showError("Esta demanda ya no está disponible")`.
2. Se procede como el flujo `with=` normal (carga colección propia + de `creatorUsername`), pero el input de cantidad del cromo demandado en "Mis cartas" queda **precargado a 1 y deshabilitado** (no se puede quitar ni cambiar) — garantiza que la respuesta realmente incluye lo que A pidió. El resto de la UI (elegir libremente qué pedir de la colección de A) no cambia.
3. Al enviar, `sendOffer()` incluye `marketplaceDemandId: 123` en el body de `createOffer`.

Si el viewer llega a `trade.html?demandId=123` sin tener el cromo (débería ser imposible vía el botón, que está deshabilitado en ese caso, pero por si acceden directo a la URL): el input aparece igual bloqueado en 1 pero la validación backend al enviar falla igual que cualquier oferta sin stock suficiente (409 ya existente en `trade.ts`).

### Backend: `POST /api/trade/offers` — validación del enlace a demanda

Cuando el body incluye `marketplaceDemandId`:
- La demanda debe existir (si no, 409 "La demanda ya no está disponible" — pudo cerrarse entre que B cargó la página y envió).
- `toUsername` resuelto debe coincidir con el `creator_id` de la demanda (400 si no — defensa en profundidad, la UI ya fuerza esto).
- `offerCards` debe contener exactamente `{ cardId: demandCardId, quantity: 1 }` entre sus ítems (400 "Debes ofrecer el cromo demandado" si no — defensa en profundidad, el input bloqueado en la UI ya lo garantiza).
- Inserta `trade_offers.marketplace_demand_id = marketplaceDemandId`.

### Aceptar una respuesta (reutiliza `POST /api/trade/offers/:id/accept` tal cual)

Sin cambios en la mecánica de transferencia de cartas (ya funciona). Al final, si `offer.marketplace_demand_id` no es `NULL`:
1. Borra la fila de `marketplace_offers` (cierra la demanda, desaparece del listado público).
2. Cualquier otro `trade_offers` pendiente con el mismo `marketplace_demand_id` (respuestas de otros usuarios a la misma demanda) pasa a `status = 'declined'` — ya no tiene sentido, la demanda se cumplió por otro camino.

Ambos pasos en el mismo helper `closeDemand(env, demandId, exceptOfferId?)`: borra la demanda y pone `status = 'declined'` en los `trade_offers` pendientes con ese `marketplace_demand_id`, salvo `exceptOfferId` (la oferta que se acaba de aceptar, que ya gestiona su propio `status = 'accepted'` por su cuenta). Cancelación y expiración llaman al mismo helper sin `exceptOfferId` (no hay ninguna oferta que excluir).

### Mis demandas

`GET /api/marketplace/offers/mine`: demandas abiertas del usuario (tope natural de 4), sin paginar. Cada una con botón "Cancelar" → `closeDemand()` (borra la demanda + auto-rechaza respuestas pendientes vinculadas). Ya no hay estado "aceptada" que mostrar aquí — en cuanto se acepta una respuesta, la demanda desaparece de esta vista y el intercambio queda registrado en `offers.html` como cualquier trade aceptado.

### Expiración automática

Sweep lazy (mismo patrón que hoy), ejecutado al inicio de `GET /offers` y `GET /offers/mine` del marketplace:
- Demandas con `created_at <= now - 7 días` → `closeDemand()` (borra + auto-rechaza respuestas vinculadas pendientes).

Las respuestas pendientes en sí (filas de `trade_offers`) ya expiran a los 7 días vía el `expireStaleOffers()` existente en `trade.ts`, sin cambios — es independiente de si la demanda que las originó sigue viva o no.

### `offers.html` — señalizar que una oferta viene de una demanda

`GET /api/trade/offers` añade `isMarketplaceResponse: boolean` por oferta (`marketplace_demand_id !== null`). Sin joins extra: el cromo que cumple la demanda ya se muestra como parte normal de la oferta (lado "ofrece"), esto solo añade una etiqueta pequeña ("Respuesta a demanda") en la cabecera de la tarjeta para que A entienda de dónde viene, sin cambiar accept/decline/cancel/delete (idénticos a hoy).

### Fuera de alcance

- Eliminar/migrar `marketplace_offer_items`, columnas muertas de `marketplace_offers` (`status`/`acceptor_id`/`accepted_at`) o `user_cards.reserved` — quedan sin usar, no se tocan.
- Impedir que un mismo usuario responda dos veces a la misma demanda — sin restricción, igual que trade.ts no restringe ofertas duplicadas entre dos usuarios.
- Cantidad > 1 en el cromo demandado — sigue siendo siempre exactamente 1.
- Mostrar el nombre del cromo demandado en la etiqueta de `offers.html` (requeriría join extra) — el cromo ya es visible en la propia tarjeta de la oferta.

## Testing

`vitest.workers.config.ts`:
- Crear demanda respeta el tope de 4 activas por creador.
- `GET /api/marketplace/offers` lista solo demandas ajenas, `demandQuery` filtra por nombre, "Tienes X" refleja disponible del viewer.
- `GET /api/marketplace/offers/:id` devuelve datos de una demanda abierta, 404 si no existe.
- `POST /api/trade/offers` con `marketplaceDemandId`: 409 si la demanda ya no existe, 400 si `toUsername` no coincide con el creador, 400 si `offerCards` no incluye el cromo demandado en cantidad 1.
- Aceptar una respuesta enlazada borra la demanda y auto-rechaza otras respuestas pendientes de la misma demanda (otros usuarios), sin tocar respuestas pendientes de demandas distintas.
- Cancelar una demanda propia la borra y auto-rechaza sus respuestas pendientes.
- Sweep expira demandas a los 7 días (borra + auto-rechaza respuestas vinculadas pendientes).
- `GET /api/trade/offers` incluye `isMarketplaceResponse` correcto (`true`/`false`).

Manual: crear demanda (paso único), verla en el listado público de otro usuario, responder vía `trade.html?demandId=`, comprobar cromo demandado bloqueado en 1, aceptar en `offers.html`, comprobar que la demanda desaparece y otras respuestas pendientes a la misma demanda quedan "Rechazada".
