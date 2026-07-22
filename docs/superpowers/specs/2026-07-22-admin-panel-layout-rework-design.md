# Rediseño compacto en 2 columnas del panel admin

## Objetivo

El panel admin (`admin.html`) usa el mismo estilo cozy/espaciado del resto
de la web (fuentes grandes, padding generoso) y un grid de 2 columnas que
no agrupa las secciones de forma útil (las tarjetas `span-2` rompen el
flujo). Tras añadir el bloque de 2 columnas del sobre de prueba, el panel
quedó descolocado. Este cambio reorganiza el panel en 2 columnas
funcionales y lo hace visualmente compacto, sin tocar el estilo del resto
del sitio. Solo desktop importa (90% del uso real es PC).

## Estructura (`admin.html`)

`#panel-view` pasa de `.admin-grid` (grid 1fr/1fr con tarjetas sueltas
marcadas `.span-2` para ocupar ancho completo) a un layout de 2 columnas
explícitas:

```
.admin-columns (grid, 2 columnas)
├── .admin-col-left (flex column)
│   ├── card "Buscar y dar sobres"
│   ├── card "Sobre de prueba"
│   └── card "Configuración de sobres automáticos"
└── .admin-col-right (flex column)
    ├── card "Donaciones de PayPal sin asignar"
    └── card "Historial"
```

Ningún contenido interno de las tarjetas cambia — solo se reordena el
wrapping HTML para agrupar 3 tarjetas a la izquierda y 2 a la derecha, en
vez de dejar que el grid las coloque por orden de aparición.

## Compacto sin afectar al resto de la web

`.card`, `.btn`, `.input`, `h2` son clases compartidas con
collection/trade/album/marketplace — no se tocan sus reglas base.  En su
lugar, `src/style.css` añade overrides con el selector `#panel-view`
delante (p. ej. `#panel-view .card { padding: ...; }`,
`#panel-view h2 { font-size: ...; }`) que solo aplican dentro del panel
admin. Mismo `JetBrains Mono`, mismos colores de marca (`--pink`,
`--gold`, `--bg` crema) — solo tamaños de fuente y paddings reducidos.

`.cfg-columns`, `.cfg-column`, `.cfg-column-title`, `.cfg-label-text`,
`.tp-columns` son clases exclusivas del admin (no se usan en ninguna otra
página, verificado) — se editan directamente para reducir su tamaño,
sin necesidad de scoping.

`admin.ts` no cambia — las clases (`.card`, `.btn`, `.input`, `.badge`)
que genera dinámicamente (resultados de búsqueda, filas de donaciones,
filas de historial) mantienen los mismos nombres.

## Scroll independiente en la columna derecha

- `#paypal-donations-list`: `max-height: 260px; overflow-y: auto;`
- El `<table>` de Historial se envuelve en un contenedor
  `.history-table-wrap` con `max-height: 420px; overflow-y: auto;`, y su
  `<thead>` lleva `position: sticky; top: 0;` con el mismo fondo de la
  tarjeta, para que las cabeceras de columna no desaparezcan al hacer
  scroll dentro de la tabla.

Estas alturas son un punto de partida razonable para desktop, no un
requisito exacto del usuario — ajustables si en uso real se ven mal.

## Fuera de alcance

- No se toca `login-view` (antes de autenticar) — el rediseño es solo
  para el contenido de `#panel-view`.
- No se optimiza para móvil (uso real es 90% desktop).
- No se renombra ninguna clase que `admin.ts` genere dinámicamente.

## Testing

- No hay test automatizado de `src/admin.ts` ni de `admin.html` hoy
  (confirmado en el spec anterior de test-pack). Verificación manual en
  navegador tras el cambio: comprobar que el resto de páginas
  (collection/trade/album/marketplace) no cambian visualmente (las
  reglas nuevas están scoped a `#panel-view`), y que el panel admin se ve
  en 2 columnas con scroll independiente en PayPal/Historial.
