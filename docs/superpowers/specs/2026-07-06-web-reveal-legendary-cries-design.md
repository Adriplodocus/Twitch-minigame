# Cries de legendarios en la apertura web (no solo overlay)

## Problem

`overlay.ts` ya reproduce el cry del Pokémon cuando sale una carta legendaria (ver spec `2026-07-06-legendary-cries-design.md`). La apertura en la web (`collection.html` normal y el reveal de "sobre de prueba" en admin) usa el mismo componente compartido `src/pack-reveal.ts` pero no reproduce cries — solo el sonido shiny.

## Design

### Backend

`worker/routes/collection.ts` (`POST /packs/:id/open`) y `worker/routes/admin.ts` (`POST /test-pack`): añadir `c.sort_order AS sortOrder` al `SELECT` de detalle de carta (`cardDetails`/equivalente), igual que ya tiene `GET /api/collection`. El dex number se deriva client-side igual que en `card.ts`/`overlay.ts`: `Math.floor(sortOrder / 1_000_000)`.

### Frontend (`src/pack-reveal.ts`)

En el loop de `showPackReveal`, junto al chequeo de `isShiny` existente:

```ts
if (cards[i].rarity === "legendary") {
  new Audio(`/cries/${Math.floor((cards[i].sortOrder ?? 0) / 1_000_000)}.ogg`).play().catch(() => {});
}
if (splitCardName(cards[i].name).isShiny) {
  new Audio("/shiny-sound.mp3").play().catch(() => {});
}
```

Mismo comportamiento que `overlay.ts`: si la carta es legendary y shiny a la vez, suenan ambos audios en paralelo, sin prioridad. Si falta el `.ogg` (dexNumber sin cry subido), falla silenciosamente vía `.catch(() => {})`.

Cubre automáticamente `collection.html` (apertura normal) y el reveal de "sobre de prueba" en `admin.html`, al compartir ambos el mismo `showPackReveal`.

## Testing

Sin test nuevo — mismo nivel de cobertura que el resto de `pack-reveal.ts`/`revealPack` (manipulación de DOM/audio sin test unitario existente). Verificación manual en ambos flujos tras implementar.

## Out of scope

- Cries en el paso de reveal por rareza distinta a legendary.
- Cambios al mecanismo de cries ya existente en overlay.ts.
