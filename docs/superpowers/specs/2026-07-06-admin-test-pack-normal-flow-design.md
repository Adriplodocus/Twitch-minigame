# Sobre de prueba admin sigue el flujo normal de apertura

## Problem

Hoy `POST /api/admin/test-pack` crea el pack con `opened_at` y `broadcast_at` seteados en el mismo INSERT — el admin nunca ve el reveal en la web y el pack se emite al overlay instantáneamente, sin posibilidad de elegir. Se quiere que el admin vea la animación de apertura (igual que un viewer en `collection.html`) y decida si lo manda a stream.

## Design

### Backend (`worker/routes/admin.ts`)

`POST /test-pack` (modificado): igual que hoy recoge `generation`/`tier`, valida, escoge cartas con `pickRandomCards`. Cambios en el INSERT del pack:

```sql
INSERT INTO packs (user_id, source, tier, granted_by, opened_at, is_test)
VALUES (?, 'admin', ?, ?, CURRENT_TIMESTAMP, 1)
```

(sin `broadcast_at` — el pack queda abierto pero no emitido). Tras insertar `pack_cards`, se consultan los detalles de las cartas (mismo patrón que `collection.ts` en `/packs/:id/open`: `SELECT id, name, rarity, image_path AS imagePath FROM cards WHERE id IN (...)`) y se devuelve:

```json
{ "packId": 123, "cards": [{ "id": "p150", "name": "Mewtwo", "rarity": "legendary", "imagePath": "/cards/p150.png", "quantity": 1 }, ...] }
```

`POST /test-pack/:id/broadcast` (nuevo, `requireAdmin`):
1. `SELECT id, opened_at, is_test FROM packs WHERE id = ?`.
2. Si no existe o `is_test != 1` → 404 (evita usar esta ruta para emitir packs de viewers reales).
3. Si `opened_at` es null → 409 (`{ error: "Pack not opened yet" }`).
4. `UPDATE packs SET broadcast_at = CURRENT_TIMESTAMP WHERE id = ?` → `{ ok: true }`.

No se toca `user_cards` (fuera de alcance — el `__test__` user no tiene sesión de viewer real, no aporta nada persistir su colección).

### Frontend

**Nuevo módulo `src/pack-reveal.ts`**, extraído de `revealPack`/`preloadImage` en `src/collection.ts`:

```ts
export function showPackReveal(
  cards: CardView[],
  onBroadcast: () => Promise<void>,
  femaleVariantBaseNames?: Set<string>,
  formLabels?: Map<string, string>
): Promise<void>
```

Misma animación (overlay fullscreen, cartas apareciendo una a una con `preloadImage` + stagger 400ms + sonido shiny), mismos botones "Cerrar" / "Cerrar y mostrar en stream" — el botón de broadcast ahora llama a `onBroadcast()` en vez de `broadcastPack(packId)` directamente, y mantiene el mismo patrón de error (deshabilitar botón, "Error, reintentar" si falla).

`src/collection.ts`: `revealPack(packId, cards)` pasa a ser:

```ts
async function revealPack(packId: number, cards: CardView[]): Promise<void> {
  await showPackReveal(cards, () => broadcastPack(packId), femaleVariantBaseNames, formLabels);
  document.getElementById("owned-grid")!.dispatchEvent(new Event("reload-collection"));
}
```

`src/admin.ts`: `openTestPack()` cambia de esperar `{ ok: true }` a esperar `{ packId, cards }`; en éxito llama a `showPackReveal(cards, async () => { const r = await request(\`/test-pack/${packId}/broadcast\`, { method: "POST" }); if (!r.ok) throw new Error(); })` (sin `femaleVariantBaseNames`/`formLabels` — igual que `overlay.ts`, que tampoco los pasa). El mensaje `messageEl` deja de decir "enviado al overlay"; solo reporta errores de creación del pack.

### Error handling

- Crear el pack falla (400/401/500) → mismo `messageEl.textContent = "Error al abrir el sobre de prueba."` de hoy.
- Broadcast falla → gestionado dentro de `showPackReveal` (botón vuelve a habilitarse con texto "Error, reintentar"), igual que en `collection.html`.

## Testing

Nuevos tests worker (`test/routes/admin.test.ts` o archivo nuevo si no cubre `test-pack` todavía — hoy no hay ninguno):
- `POST /test-pack` → `200`, respuesta incluye `packId` y `cards` (longitud 10), pack queda con `opened_at` no nulo y `broadcast_at` nulo en DB.
- `POST /test-pack/:id/broadcast` sobre un pack recién creado → `200`, `broadcast_at` pasa a no nulo.
- `POST /test-pack/:id/broadcast` sobre un pack inexistente o con `is_test=0` → `404`.
- `POST /test-pack/:id/broadcast` sobre un test-pack sin abrir (no debería poder ocurrir con el flujo actual, pero se valida igual) → `409`.

Frontend: sin test nuevo — `revealPack`/`showPackReveal` es manipulación de DOM sin test existente hoy tampoco (mismo nivel de cobertura que antes).

## Out of scope

- Paso intermedio de "sobre cerrado clicable" antes del reveal (se descarta explícitamente, ver conversación).
- Persistir `user_cards` para el usuario de prueba.
- Cambios en el filtro `WHERE p.is_test = 0` del historial de admin.
