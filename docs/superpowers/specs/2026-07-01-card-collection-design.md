# Diseño: Colección de Cartas Twitch

**Fecha:** 2026-07-01
**Estado:** Aprobado

## Resumen

Web donde los viewers del canal ven su colección de cartas coleccionables. Canjean una recompensa de Channel Points en Twitch para obtener un sobre; lo abren en la web con animación de reveal; pueden intercambiar cartas con otros viewers.

## Objetivo / motivación

Aumentar engagement de la comunidad de Twitch más allá del stream en directo, dando una razón para volver a la web del canal entre streams (revisar colección, comerciar cartas).

## Stack

- **Backend:** Cloudflare Workers
- **DB:** Cloudflare D1 (SQLite) — toda la lógica transaccional vive aquí
- **Frontend:** Vite + TypeScript vanilla (sin framework), servido como static assets desde el mismo Worker
- **Restricción explícita:** sin KV (límite de requests en free tier), sin Durable Objects. Todo debe funcionar en el free tier de Cloudflare.
- **Auth:** OAuth de Twitch, sesión sin estado vía JWT firmado en cookie HttpOnly (evita necesidad de KV/DO para sesiones)

## Modelo de datos (D1)

```sql
users        (twitch_id PK, username, avatar_url, created_at)
cards        (id PK, name, rarity, image_path)              -- catálogo, alimentado por script CLI
user_cards   (user_id FK, card_id FK, quantity)              -- colección; PK compuesta (user_id, card_id)
packs        (id PK, user_id FK, opened_at NULL, created_at) -- ticket sin abrir hasta opened_at
pack_cards   (pack_id FK, card_id FK)                        -- resultado de apertura, se rellena al abrir
trade_offers (id PK, from_user FK, to_user FK, status, created_at)  -- status: pending|accepted|declined|cancelled
trade_items  (offer_id FK, side 'from'|'to', card_id FK, quantity)
```

Rareza: 4 tiers (común / rara / épica / legendaria). Duplicados se acumulan como `quantity` en `user_cards` (no se convierten en otra cosa) — esto habilita dar duplicados en trades.

Peso de probabilidad por rareza es configurable en el catálogo (`catalog.json`), valor inicial sugerido: común 60%, rara 25%, épica 12%, legendaria 3%.

## Flujo: Auth

1. Botón "Login con Twitch" → redirect a OAuth de Twitch.
2. Worker recibe callback, valida code, obtiene perfil (twitch_id, username, avatar).
3. Crea o actualiza fila en `users`.
4. Firma JWT con `twitch_id` + `username`, lo setea como cookie HttpOnly Secure.
5. Cada request autenticada valida el JWT localmente (sin lookup a servidor de sesión — evita KV/DO).

## Flujo: Canje de recompensa (EventSub)

1. Worker expone un endpoint webhook suscrito a `channel.channel_points_custom_reward_redemption.add`, filtrado a la recompensa específica configurada en el canal.
2. Verifica la firma HMAC de Twitch en cada request (`Twitch-Eventsub-Message-Signature`).
3. Al recibir el evento: busca o crea el `user` correspondiente al `user_id` del redeemer.
4. Inserta una fila en `packs` con `opened_at = NULL` (sobre pendiente, no se abre automáticamente).

## Flujo: Apertura de sobre

1. Usuario ve sus sobres pendientes en `/collection`.
2. Click "Abrir" → llamada a Worker.
3. Worker hace RNG server-side: elige 5 cartas del catálogo según pesos de rareza.
4. Inserta las 5 en `pack_cards`, hace upsert incrementando `quantity` en `user_cards` para cada una, marca `opened_at = now()`.
5. Responde con las 5 cartas resultantes; frontend anima el reveal (una a una).

Las cartas se deciden en el momento de abrir (no en el momento de canjear) — el sobre es solo un "ticket" hasta que el usuario decide abrirlo.

## Flujo: Trading

1. Usuario A busca a usuario B por username, ve su colección pública.
2. A selecciona cartas propias a ofrecer + cartas de B a pedir → crea `trade_offer` (status `pending`) con sus `trade_items` correspondientes (side `from` = cartas de A, side `to` = cartas de B).
3. B ve la oferta pendiente (recibidas) en su panel de trading, puede aceptar o rechazar.
4. Al aceptar: transacción D1 atómica que resta la `quantity` correspondiente de cada lado y la suma al lado contrario en `user_cards`. Se marca offer como `accepted`.
5. Validación server-side antes de comitear: ningún lado puede ofrecer/pedir más `quantity` de la que efectivamente posee en ese momento (revalidar en el momento de aceptar, no solo al crear la oferta, por si cambió mientras estaba pendiente).

## Frontend

Vite + TypeScript vanilla, sin framework. Vistas:

- `/` — landing + login
- `/collection` — grid de cartas propias (owned con cantidad, no-owned atenuadas/placeholder), sección de sobres pendientes con botón "abrir" y animación de reveal
- `/trade` — buscador de usuario, creación de oferta, listado de ofertas pendientes (enviadas y recibidas) con acciones aceptar/rechazar

Aplica el sistema de diseño de marca definido en las instrucciones globales del usuario (tipografía Russo One / JetBrains Mono, paleta pink `#FF56B4` / blue `#00CCFF`, componentes card/badge/btn ya definidos).

## Catálogo de cartas (tooling)

- El contenido gráfico de las cartas se diseña aparte (fuera de este proyecto) y se decide más adelante.
- v1 no lleva panel admin: catálogo se gestiona vía script CLI local (Node).
- Script lee `cards.csv` (columnas: `name, rarity, image_filename`) + carpeta `assets/cards/*.png`.
- Valida que cada imagen referenciada en el CSV existe en la carpeta.
- Genera/actualiza `catalog.json`, que alimenta el seed de la tabla `cards` en D1.
- Se ejecuta localmente antes de cada deploy; no es un endpoint expuesto en producción.
- Imágenes se sirven como static assets del Worker (misma carpeta que el frontend).

## Fuera de alcance (v1)

- Panel admin web para gestionar catálogo (se reevaluará si el script CLI resulta insuficiente).
- Conversión de duplicados en moneda/fragmentos.
- Múltiples recompensas de canje (solo una recompensa de Channel Points en v1).
- Diseño gráfico de las cartas en sí (responsabilidad del usuario, fuera del alcance de desarrollo).
