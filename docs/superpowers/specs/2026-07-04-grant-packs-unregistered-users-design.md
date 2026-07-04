# Regalar blísters a usuarios sin login previo — Design

## Contexto

Los eventos automáticos (canje de puntos, cheer, sub, gift sub — [[2026-07-04-eventsub-support-packs-design]]) crean la fila en `users` vía `upsertUser` aunque el viewer nunca haya hecho login con Twitch OAuth en la app: el sobre queda pendiente y aparece en cuanto el usuario entra por primera vez. Confirmado, no hay pérdida de datos ahí.

El hueco real está en el panel admin: `GET /api/admin/users?q=` (`worker/routes/admin.ts`) busca por coincidencia parcial solo entre filas que **ya existen** en `users`. Si un admin quiere regalar un blíster a alguien que nunca ha tocado la app de ningún modo (ni login, ni canje, ni cheer/sub), no hay fila que buscar — hoy es imposible.

## Flujo

1. El buscador local (`runSearch` en `src/admin.ts`, ya existente) sigue igual: resultados en vivo mientras se escribe, por coincidencia parcial.
2. Si tras el debounce no hay resultados locales y el campo no está vacío, se añade una fila extra clicable: `Dar sobres a "<texto escrito>" (buscar en Twitch)`.
3. Al pulsarla, se llama a `POST /api/admin/lookup-user` con el texto exacto. Si Twitch tiene ese username exacto, se crea/actualiza la fila en `users` y se selecciona como si fuera un resultado normal (mismo flujo de cantidad/tier/confirmar que ya existe para grant-packs). Si no existe en Twitch, se muestra un error inline.

Esto evita llamar a la API de Twitch en cada tecla — solo se dispara cuando el admin confirma explícitamente que quiere intentarlo con ese texto.

## `worker/lib/twitch.ts`

Nueva función, mismo estilo que las existentes (`fetchImpl` inyectable para tests):

```ts
export async function getUserByLogin(
  login: string,
  accessToken: string,
  clientId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ id: string; login: string; profileImageUrl: string } | null> {
  const res = await fetchImpl(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId },
  });
  if (!res.ok) throw new Error(`Twitch get user by login failed: ${res.status}`);
  const json = (await res.json()) as { data: { id: string; login: string; profile_image_url: string }[] };
  const user = json.data[0];
  return user ? { id: user.id, login: user.login, profileImageUrl: user.profile_image_url } : null;
}
```

## `worker/routes/admin.ts`

Nuevo endpoint `POST /lookup-user` (`requireAdmin`):

```ts
admin.post("/lookup-user", requireAdmin, async (c) => {
  const body = await c.req.json<{ username?: string }>().catch(() => ({}) as { username?: string });
  const username = body.username?.trim();
  if (!username) return c.json({ error: "Username required" }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT twitch_id AS twitchId, username, avatar_url AS avatarUrl FROM users WHERE username = ?"
  )
    .bind(username)
    .first<{ twitchId: string; username: string; avatarUrl: string | null }>();
  if (existing) return c.json({ user: existing });

  const appAccessToken = await twitch.getAppAccessToken({
    clientId: c.env.TWITCH_CLIENT_ID,
    clientSecret: c.env.TWITCH_CLIENT_SECRET,
  });
  const twitchUser = await twitch.getUserByLogin(username, appAccessToken, c.env.TWITCH_CLIENT_ID);
  if (!twitchUser) return c.json({ error: "Twitch user not found" }, 404);

  await c.env.DB.prepare(
    `INSERT INTO users (twitch_id, username, avatar_url) VALUES (?, ?, ?)
     ON CONFLICT(twitch_id) DO UPDATE SET username = excluded.username, avatar_url = excluded.avatar_url`
  )
    .bind(twitchUser.id, twitchUser.login, twitchUser.profileImageUrl)
    .run();

  return c.json({
    user: { twitchId: twitchUser.id, username: twitchUser.login, avatarUrl: twitchUser.profileImageUrl },
  });
});
```

(Import `* as twitch from "../lib/twitch"` en `admin.ts`, no existe todavía ahí.)

## Frontend — `src/admin.ts`

En `runSearch`, cuando `result.data.users.length === 0` y la query no está vacía, `renderSearchResults` añade una entrada especial (mismo `<span class="badge">` clicable que ya usa para resultados normales, pero con texto `Dar sobres a "${query}" (buscar en Twitch)` y un dataset marcándola como lookup remoto en vez de selección directa). Al hacer click:

```ts
async function lookupTwitchUser(username: string): Promise<void> {
  const result = await request<{ user: AdminUser }>("/lookup-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!result.ok) {
    if (result.status === 401) { showLoginView(); return; }
    document.getElementById("search-results")!.innerHTML =
      `<p>No existe ningún usuario de Twitch con ese nombre.</p>`;
    return;
  }
  selectUser(result.data.user);
}
```

`selectUser` ya existe y hace exactamente lo necesario (marca el usuario elegido, habilita el botón de dar blíster) — no cambia.

## Testing

- `test/lib/twitch.test.ts`: `getUserByLogin` devuelve el usuario cuando Twitch lo tiene, `null` cuando `data` viene vacío.
- `test/routes/admin.test.ts` para `/lookup-user`:
  - 401 sin sesión admin.
  - 400 si falta `username`.
  - Devuelve el usuario existente sin llamar a Twitch (mock de `getAppAccessToken`/`getUserByLogin` no invocado) si ya hay fila local con ese username exacto.
  - Crea la fila en `users` y la devuelve si Twitch lo encuentra y no existía localmente.
  - 404 si Twitch tampoco lo tiene.

## Fuera de alcance

- Autocompletar/sugerir usernames de Twitch mientras se escribe (la API de Twitch no soporta búsqueda parcial pública) — solo lookup exacto bajo demanda.
- Cambiar el comportamiento del buscador local existente.
