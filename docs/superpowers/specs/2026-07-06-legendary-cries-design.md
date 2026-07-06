# Cries de Pokémon legendarios en overlay.html

## Problem

Cuando aparece una carta `rarity=legendary` en el overlay de apertura de sobres, hoy solo hay confetti+shake (sin sonido propio). Queremos reproducir el cry real del Pokémon.

## Design

### Mapeo carta → dex number

`sort_order` en la tabla `cards` ya codifica el national dex number en los dígitos superiores: `dexNumber = Math.floor(sort_order / 1_000_000)` (mismo cálculo que `computeGeneration` en `tools/catalog/build-catalog.ts:103`). Las 370 cartas `legendary` actuales mapean a 94 dex numbers únicos — formas/tipos (Arceus por tipo, Deoxys Attack/Defense/Speed, Giratina Altered/Origin, etc.) comparten el cry de la especie base. No se añade columna nueva ni tabla de mapeo: se deriva en request time a partir de un dato que ya existe.

### Backend (`worker/routes/overlay.ts`)

- Añadir `ca.sort_order AS sortOrder` al `SELECT` de `/events`.
- `EventCardRow` y el cuerpo de cada carta del evento incluyen `sortOrder`.
- Al construir `OverlayEvent.cards`, incluir `dexNumber: Math.floor(row.sortOrder / 1_000_000)`.

### Assets (`public/cries/`)

94 archivos `<dexNumber>.ogg`, uno por cada dex number único presente entre las cartas `legendary` del catálogo actual. Origen: repo público `github.com/PokeAPI/cries` (carpeta `legacy`, cobertura consistente para todas las especies). Se pide permiso explícito antes de descargar cada lote.

Formato `.ogg` sin transcodificar: el overlay solo corre como browser source de OBS (Chromium/CEF), que soporta Ogg Vorbis nativamente — no hace falta compatibilidad con Safari.

### Frontend (`src/overlay.ts`)

`OverlayEventCard` gana el campo `dexNumber: number`.

En `playCardSequence`, dentro del bloque que ya distingue `kind` (`hypeKind()`):

```ts
if (kind === "legendary") {
  new Audio(`/cries/${card.dexNumber}.ogg`).play().catch(() => {});
  if (splitCardName(card.name).isShiny) {
    new Audio("/shiny-sound.mp3").play().catch(() => {});
  }
}
if (kind === "shiny") {
  new Audio("/shiny-sound.mp3").play().catch(() => {});
}
```

Si la carta es legendary Y shiny, suenan ambos audios en paralelo (sin prioridad, sin mezcla especial). El resto de `playCardSequence` (confetti, shake, clases `hype-legendary`/`hype-shiny`) no cambia.

### Error handling

Si falta el `.ogg` para un dex number (legendario nuevo en el catálogo sin cry aún subido), `Audio().play()` falla silenciosamente vía `.catch(() => {})` — mismo patrón ya usado para `shiny-sound.mp3`. No hay validación en build ni alerta visible.

## Testing

- Test existente de `worker/routes/overlay.ts` (si existe en `test/routes/`) se extiende para verificar que `dexNumber` aparece en la respuesta de `/api/overlay/events` y su valor coincide con `Math.floor(sort_order / 1_000_000)`.
- Cambio en `src/overlay.ts` es solo reproducción de audio (efecto secundario no observable por test unitario) — verificación manual en overlay real (o preview standalone) tras implementar.

## Out of scope

- Cries distintos por forma/tipo regional (todas las formas de una especie comparten el cry base).
- Validación en `catalog:build` de que todo dex number `legendary` tenga un `.ogg` correspondiente.
- Cries para otras rarezas (`common`/`rare`/`epic`).
