# Cozy redesign — design spec

## Goal

Replace current dark/neón look (cyberpunk-tech feel) with a warm, cozy, friendly look across all 4 pages (`index.html`, `album.html`, `collection.html`, `trade.html`). Approved via mockup in browser companion.

## Scope

- `src/style.css` — full token + component rewrite (single stylesheet, no new files needed)
- `index.html` — swap font `<link>` to include Quicksand instead of/alongside current
- `src/collection.ts:69` — hardcoded pack-reveal overlay color needs a warm equivalent
- No HTML structure changes, no new components — this is a visual/token-level restyle. Existing class names (`.card`, `.btn`, `.badge`, `.section-heading`, `.gender-icon`, `.shiny-icon`, `.card-qty`, `.info-btn`, `.info-tooltip`, `.card-grid`) stay as-is; only their CSS changes.

## Design tokens

Replace `:root` in `src/style.css`:

```css
:root {
  --pink: #F2739E;
  --blue: #5AC8D8;
  --gold: #E8B93A;
  --purple: #B79AF0;

  --bg: #FAF3E6;
  --surface: #FFFFFF;
  --surface2: #F3E8D6;

  --border: rgba(120, 90, 60, 0.14);

  --text: #6E5C4C;
  --text-em: #3B2E22;
  --muted: #9C8874;
  --dim: #C9B79E;
}

html { background: #F3E8D6; }
```

Rarity border colors switch from `--blue` / `#8B5CF6` / `#FFD700` to `--blue` / `--purple` / `--gold` (values above already warmed).

## Typography

- Titles (`h1, h2, h3`): keep **Russo One** (brand identity), color `--text-em`. Add a soft warm text-shadow on the hero `h1` only (`0 2px 0 rgba(232,185,58,0.25)`), not on all headings.
- Body/UI: switch from JetBrains Mono to **Quicksand** (weights 500/700).
- JetBrains Mono is kept only for numeric/stat contexts: `.card-qty`, `.section-heading .count`. Everything else (buttons, badges, nav, labels, card names) moves to Quicksand.
- Font `<link>` in all 4 HTML files updates to:
  `family=Russo+One&family=Quicksand:wght@500;700&family=JetBrains+Mono:wght@600&display=swap`

## Shape & shadow

- Card border-radius: `14px` → `20px`. Card art inner radius: `8px` → `14px`.
- Card shadow replaces neon glow-on-hover with a soft diffuse shadow + lift:
  - Rest: `box-shadow: 0 4px 16px rgba(120, 90, 60, 0.10);`
  - Hover: `transform: translateY(-4px); box-shadow: 0 10px 26px rgba(120, 90, 60, 0.18);` (drop the `border-color` hover swap — rarity border already carries color)
- Buttons (`.btn`): keep pill shape (`border-radius: 100px`). Default state becomes a solid warm-pink fill (`background: var(--pink); color: #fff;`) with a soft pink shadow (`0 4px 14px rgba(242,115,158,0.35)`) instead of the current flat `--surface2` + border-hover-glow pattern. Hover: slight lift (`translateY(-2px)`), shadow intensifies.
- Badges (`.badge`): keep pill shape, restyle to warm gold tone (`background: rgba(232,185,58,0.18); color: #9C7A17;`) — matches the "Rare/Epic/Legendary" corner badge shown in the mockup, reused for the existing `.badge` class.
- Inputs: border-radius `8px` → `12px`, focus ring uses `--pink` at low alpha instead of `--blue`.

## Component-by-component changes (`src/style.css`)

| Selector | Change |
|---|---|
| `:root` | New token values (above) |
| `html`, `body` | `bg: #F3E8D6` / `var(--bg)`, font-family → Quicksand |
| `h1, h2, h3` | font stays Russo One, color `--text-em` (no change needed beyond token cascade) |
| `.card` | radius 20px, new shadow (rest+hover per above), drop border-color hover transition |
| `.card.unowned` | keep opacity 0.7 + grayscale filter, no change |
| `.card-art` | radius 14px, background `var(--surface2)` |
| `.card.card-rarity-rare/epic/legendary` | border-color → `--blue` / `--purple` / `--gold` |
| `.gender-icon` | background `var(--surface2)` instead of `rgba(0,0,0,0.55)` (dark chip reads harsh on cream) |
| `.shiny-icon` | drop-shadow stays but softened: `drop-shadow(0 0 3px rgba(120,90,60,0.35))` |
| `.card-qty` | background `var(--surface2)`, color `var(--text-em)`, font Mono (unchanged family) |
| `.info-btn` | background `var(--surface2)`, border `var(--border)`, hover border/color → `--pink` (was `--blue`) |
| `.info-tooltip` | background `var(--surface)`, shadow softened `0 6px 20px rgba(120,90,60,0.20)` |
| `.section-heading` | font Quicksand 700, `.count` stays Mono |
| `.btn` | pill + solid pink fill + soft shadow (above) |
| `.badge` | warm gold pill (above) |
| `.card-grid` | no change (layout only) |
| `@keyframes card-in` | no change |

## `src/collection.ts:69` overlay

Pack-reveal fullscreen overlay hardcodes `background: rgba(0,0,0,0.85)`. Replace with a warm dark overlay so it doesn't clash with the cream page behind it when it fades in/out: `rgba(59, 46, 34, 0.80)`.

## Out of scope

- No layout/structural changes to any page.
- No new pages or components.
- Pack-opening reveal animation logic untouched, only the overlay color.
- Card artwork (`public/cards/*.png`) untouched.

## Verification

- `npm run dev` (or existing dev script), visually check all 4 pages: index/login, album, collection (including pack reveal overlay), trade.
- Confirm rarity border colors still visually distinct on cream background.
- Confirm text contrast (`--text` on `--bg`, `--text-em` on `--surface`) is readable.
