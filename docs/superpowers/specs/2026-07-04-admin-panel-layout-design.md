# Panel admin — layout en grid compacto - Design

## Contexto

`admin.html` apila sus 4 bloques ("Buscar y dar sobres", "Sobre de prueba", "Configuración de sobres automáticos", "Historial") en una sola columna dentro de `.container` (max-width 860px, definido en el sistema de diseño global), cada uno con estilos inline sueltos (`style="margin-top: 2rem"` repetido, sin usar el componente `.card` ya definido en `style.css`). En una pantalla de escritorio deja la mayor parte del ancho vacío.

Explorado con el companion visual: 3 opciones de grid (3 columnas iguales / asimétrico / 2 columnas + config ancha). Elegida: **2 columnas arriba, config automática ocupando el ancho completo con sus 5 campos en fila, historial abajo a todo el ancho**.

## Contenedor

`admin.html` usa hoy `<div class="container" style="padding: 2rem 1rem;">`. Se sustituye por una clase propia en `style.css`:

```css
.container-admin {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem 1rem;
}
```

(mismo patrón que `.container-album { max-width: 1550px; }` ya existente — un contenedor más ancho para una página que lo necesita, sin tocar el `.container` base de 860px que usan el resto de páginas).

## Grid superior

```css
.admin-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
  margin-top: 1.5rem;
}
@media (max-width: 700px) {
  .admin-grid { grid-template-columns: 1fr; }
}
.admin-grid .span-2 {
  grid-column: 1 / -1;
}
```

Estructura de `admin.html` dentro de `#panel-view`:

```html
<div class="admin-grid">
  <div class="card">
    <!-- Buscar y dar sobres: buscador, resultados, selección, cantidad/tier/botón -->
  </div>
  <div class="card">
    <!-- Sobre de prueba -->
  </div>
  <div class="card span-2">
    <!-- Configuración de sobres automáticos -->
  </div>
  <div class="card span-2">
    <!-- Historial -->
  </div>
</div>
```

Los 4 bloques pasan de `<div style="margin-top: 2rem;">` sueltos a `<div class="card">` — usa el componente ya definido (`background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 1.15rem 1.4rem;`), dándoles límite visual propio en vez de solo espaciado vertical.

## Configuración de sobres automáticos — en fila

Hoy sus 5 `<label>` van en columna (`flex-direction: column`) dentro de un contenedor `max-width: 320px`. Al tener las 2 columnas de ancho disponibles (por el `span-2`), pasan a fila:

```css
.cfg-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.cfg-fields label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
  flex: 1 1 160px;
}
```

Cada `<label>` mantiene su `<input>` debajo del texto (evita que 5 inputs numéricos en una sola línea sin contexto sean confusos), pero los 5 conjuntos se acomodan en fila(s) según el ancho, envolviendo en pantallas más estrechas.

## Limpieza de estilos inline

Todos los `style="margin-top: ..."`, `style="max-width: 320px"`, `style="display:flex; ..."` sueltos en `admin.html` que ya cubre `.card`/`.admin-grid`/`.cfg-fields` se eliminan a favor de esas clases. Los que no tienen equivalente reusable (ej. anchos puntuales de inputs concretos) se mantienen tal cual — no se hace limpieza especulativa de lo que no toca este cambio.

## `src/admin.ts`

Sin cambios de lógica — todo sigue por `id` (`document.getElementById(...)`), y ningún `id` cambia de nombre. Solo cambia el HTML/CSS alrededor.

## Testing

Cambio puramente visual/estructural sin lógica nueva — no hay función pura que testear. Verificación manual en navegador (desktop y ventana estrecha) tras el cambio, siguiendo la skill `verify`.

## Fuera de alcance

- Rediseñar el resto de páginas (`collection.html`, `trade.html`, etc.) — solo `admin.html`.
- Cambiar el copy o el orden funcional de los bloques, solo su disposición espacial.
