# "¿Cómo conseguir sobres?" header popover

## Problem

Viewers don't know all the ways to earn packs (channel reward, sub, gift subs, bits, PayPal). Only the PayPal donate button hints at anything, and only about itself.

## Design

Add a button "¿Cómo conseguir sobres?" in `page-header-user`, next to `donate-btn`, on all 4 viewer pages (`collection.html`, `trade.html`, `offers.html`, `album.html`). Not on `admin.html`.

Clicking toggles a popover panel listing all ways to get packs:

| Acción | Recompensa |
|---|---|
| Canjea la recompensa del canal | Sobre normal |
| Suscríbete | Sobre especial |
| Regala suscripciones | x1 sobre por cada sub — Sobre especial |
| Dona bits | x1 sobre por cada 200 bits — Sobre especial |
| Donación en PayPal | x1 sobre por cada 2€ — Sobre especial |

Static content, no API call — same list on every page since it doesn't depend on viewer-specific data.

### Markup (replicated in the 4 HTML files)

```html
<div class="info-popover-wrap">
  <button class="btn btn-icon" id="how-to-btn" type="button" aria-haspopup="true" aria-expanded="false">
    <svg ...info-circle icon... />
    ¿Cómo conseguir sobres?
  </button>
  <div class="info-popover" id="how-to-panel" hidden>
    <ul>
      <li><strong>Canjea la recompensa del canal</strong><span>Sobre normal</span></li>
      <li><strong>Suscríbete</strong><span>Sobre especial</span></li>
      <li><strong>Regala suscripciones</strong><span>x1 sobre por cada sub · Sobre especial</span></li>
      <li><strong>Dona bits</strong><span>x1 sobre por cada 200 bits · Sobre especial</span></li>
      <li><strong>Donación en PayPal</strong><span>x1 sobre por cada 2€ · Sobre especial</span></li>
    </ul>
  </div>
</div>
```

### Behavior (`src/user-header.ts`)

`initUserHeader()` already runs on all 4 pages — add the toggle logic there, no new module/import needed:

- Click `#how-to-btn` → toggle `#how-to-panel` `hidden`, flip `aria-expanded`.
- Click outside panel (and not on the button) while open → close.
- `Escape` while open → close.

### Styling (`src/style.css`)

New `.info-popover-wrap` (relative positioning anchor) and `.info-popover` (absolute panel) rules, following the design system: `--surface2` background, `--border` border, `12px` radius, popover shadow (`0 6px 24px rgba(0,0,0,0.70)`), `JetBrains Mono` body font already inherited.

## Testing

Extend `src/donate-button.test.ts` (or a new `src/how-to-get-packs.test.ts`) with the same pattern as the donate-button test: string-match assertions that `id="how-to-btn"` and `id="how-to-panel"` are present in the 4 viewer pages and absent from `admin.html`.

## Out of scope

- No server/API involvement — purely static content.
- No animation beyond existing transition conventions.
- Not closing on scroll (not needed for a short header popover).
