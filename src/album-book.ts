import type { CardView } from "./api";
import { renderCardHtml } from "./card";

// Regional/Mega/Gmax forms keep the sortOrder of their base species' national
// dex number (e.g. Tauros Paldea forms sort near #128) even though their
// generation is overridden to when that form was introduced (see
// computeGeneration in tools/catalog/build-catalog.ts). Inside a generation's
// album this would place them before that generation's own dex entries, so
// push them to the end while preserving their relative order.
const FORM_OVERRIDE_RE = /\b(Alola|Galar|Hisui|Paldea|Mega|Gmax)\b/;

function albumSortKey(card: CardView): number {
  const base = card.sortOrder ?? 0;
  return FORM_OVERRIDE_RE.test(card.name) ? base + 1_000_000_000_000 : base;
}

export const PAGE_SIZE = 16;
const PAGES_PER_SPREAD = 2;

export function pageCount(cardCount: number): number {
  const contentPages = Math.max(1, Math.ceil(cardCount / PAGE_SIZE));
  return contentPages % 2 === 0 ? contentPages : contentPages + 1;
}

export function cardsForPage<T>(cards: T[], pageIndex: number): (T | null)[] {
  const start = pageIndex * PAGE_SIZE;
  const slice: (T | null)[] = cards.slice(start, start + PAGE_SIZE);
  while (slice.length < PAGE_SIZE) slice.push(null);
  return slice;
}

export interface BookDeps {
  spreadEl: HTMLElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  indicatorEl: HTMLElement;
  flipSound: HTMLAudioElement;
  femaleVariantBaseNames: Set<string>;
  formLabels: Map<string, string>;
}

const FLIP_OUT_MS = 240;
const FLIP_IN_MS = 260;

export class AlbumBook {
  private readonly cards: CardView[];
  private spreadIndex = 0;
  private readonly totalPages: number;
  private readonly totalSpreads: number;

  constructor(
    cards: CardView[],
    private readonly deps: BookDeps
  ) {
    this.cards = [...cards].sort((a, b) => albumSortKey(a) - albumSortKey(b));
    this.totalPages = pageCount(this.cards.length);
    this.totalSpreads = this.totalPages / PAGES_PER_SPREAD;
    deps.prevBtn.addEventListener("click", () => this.go(-1));
    deps.nextBtn.addEventListener("click", () => this.go(1));
    this.render();
  }

  private renderPageHtml(pageIndex: number): string {
    const slots = cardsForPage(this.cards, pageIndex);
    return `<div class="book-page">${slots
      .map((c) =>
        c
          ? renderCardHtml(c, "", this.deps.femaleVariantBaseNames, this.deps.formLabels)
          : `<div class="book-page-slot-empty"></div>`
      )
      .join("")}</div>`;
  }

  private render(): void {
    const left = this.spreadIndex * PAGES_PER_SPREAD;
    const right = left + 1;
    this.deps.spreadEl.innerHTML = this.renderPageHtml(left) + this.renderPageHtml(right);
    this.deps.prevBtn.disabled = this.spreadIndex === 0;
    this.deps.nextBtn.disabled = this.spreadIndex === this.totalSpreads - 1;
    this.deps.indicatorEl.textContent = `Páginas ${left + 1}–${right + 1} de ${this.totalPages}`;
  }

  private go(direction: -1 | 1): void {
    const nextIndex = this.spreadIndex + direction;
    if (nextIndex < 0 || nextIndex >= this.totalSpreads) return;
    this.spreadIndex = nextIndex;
    this.flipTo(direction);
  }

  private flipTo(direction: -1 | 1): void {
    const spread = this.deps.spreadEl;
    const side = direction === 1 ? "next" : "prev";
    const page =
      direction === 1
        ? spread.querySelector<HTMLElement>(".book-page:last-child")
        : spread.querySelector<HTMLElement>(".book-page:first-child");
    this.deps.flipSound.currentTime = 0;
    this.deps.flipSound.play().catch(() => {});
    page?.classList.add(`book-page-flip-out-${side}`);
    window.setTimeout(() => {
      this.render();
      const newPage =
        direction === 1
          ? spread.querySelector<HTMLElement>(".book-page:last-child")
          : spread.querySelector<HTMLElement>(".book-page:first-child");
      newPage?.classList.add(`book-page-flip-in-${side}`);
      window.setTimeout(() => newPage?.classList.remove(`book-page-flip-in-${side}`), FLIP_IN_MS);
    }, FLIP_OUT_MS);
  }
}
