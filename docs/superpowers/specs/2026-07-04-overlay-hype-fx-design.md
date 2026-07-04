# Overlay Hype FX — Design

## Contexto

La alerta de overlay (`src/overlay.ts`, ver [[2026-07-04-overlay-alerts-design]]) trata todas las cartas igual: mismo slide, mismo hold, sin refuerzo visual por rareza. Se quiere que sacar una legendary o una shiny se note más — sin tocar backend, todo lo necesario (rareza, nombre para detectar shiny) ya viaja en `OverlayEventCard`.

## Alcance

Solo frontend: `src/overlay.ts` + `src/style.css`. Sin cambios de API, tipos ni DB.

## Detección de hype

Por carta, no por sobre completo:

```ts
function isHypeCard(card: OverlayEventCard): boolean {
  return card.rarity === "legendary" || splitCardName(card.name).isShiny;
}
```

Cada carta se evalúa al mostrarse; una carta puede ser hype y otra del mismo sobre no serlo.

## Efectos en carta hype

Al entrar en `playCardSequence`, si `isHypeCard(card)`:

- Clase `card-slot.hype` en vez de la transición normal: punch de escala (zoom in-out) sustituye al slide lateral.
- Anillo de color detrás de la carta: dorado (`var(--gold)`) si `rarity === "legendary"`, rosa (`var(--pink)`) si el disparo fue solo por shiny (legendary manda si ambas).
- Confeti: ráfaga de 16-20 partículas CSS (`div.confetti-piece`, color aleatorio entre `--gold`/`--pink`/`--blue`), generadas por JS, posicionadas sobre el slot, caen con rotación y se autodestruyen (~1.2s) vía `setTimeout` + `remove()`.
- Shake sutil del contenedor `.overlay-alert` (~5px, 300ms) al entrar la carta hype.
- Hold time: `CARD_HOLD_MS + 400` para cartas hype (constante nueva `HYPE_HOLD_BONUS_MS`), para que dé tiempo a apreciar el efecto.
- Sonido: sin sonido nuevo. Se mantiene el `shiny-sound.mp3` existente solo si la carta es shiny; legendary no-shiny no suena distinto.

## Avatar en intro

`overlay-intro` pasa a incluir el avatar del usuario junto al username:

- `<img class="overlay-intro-avatar">` con `event.avatarUrl`; si es `null`, se oculta el `<img>` (no hay placeholder genérico en el proyecto para esto, mejor no mostrar nada que un roto).
- Círculo (`border-radius: 50%`), reutiliza patrón de `.user-avatar` pero más grande (`4rem`) para momento hero.
- Anillo con `avatar-pulse` (keyframe ya definido en el sistema de diseño global: pulso azul↔rosa), da vida al intro incluso en sobres sin hype.

## Fuera de alcance

- Sonido dedicado para legendary (explícitamente descartado).
- Hype a nivel de "mejor carta del sobre" mostrado antes del reveal (teaser) — se deja para una iteración futura si hace falta.
- Confeti/shake en epic (solo legendary y shiny dispara hype).
