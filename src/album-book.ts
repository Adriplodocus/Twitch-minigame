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

export function cardsForPage<T>(cards: T[], pageIndex: number): (T | null)[] {
  const start = pageIndex * PAGE_SIZE;
  const slice: (T | null)[] = cards.slice(start, start + PAGE_SIZE);
  while (slice.length < PAGE_SIZE) slice.push(null);
  return slice;
}

function chunkIntoPages(cards: CardView[]): (CardView | null)[][] {
  const count = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
  return Array.from({ length: count }, (_, i) => cardsForPage(cards, i));
}

type BookPage = (CardView | null)[];

function buildPages(cards: CardView[]): BookPage[] {
  const sorted = [...cards].sort((a, b) => albumSortKey(a) - albumSortKey(b));
  const pages: BookPage[] = chunkIntoPages(sorted);
  if (pages.length % PAGES_PER_SPREAD !== 0) pages.push(new Array(PAGE_SIZE).fill(null));
  return pages;
}

export interface BookDeps {
  spreadEl: HTMLElement;
  firstBtn: HTMLButtonElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  lastBtn: HTMLButtonElement;
  indicatorEl: HTMLElement;
  flipSound: HTMLAudioElement;
  femaleVariantBaseNames: Set<string>;
  formLabels: Map<string, string>;
}

const FLIP_OUT_MS = 240;
const FLIP_IN_MS = 260;

// Below this width the two-page spread doesn't fit (see .book-spread's
// 700px breakpoint in style.css), so the book falls back to one page at a
// time instead of shrinking cards past readability.
const MOBILE_QUERY = "(max-width: 700px)";

export class AlbumBook {
  private readonly pages: BookPage[];
  private spreadIndex = 0;
  private readonly totalPages: number;
  private pagesPerSpread: number;
  private totalSpreads: number;
  private readonly mobileQuery = window.matchMedia(MOBILE_QUERY);

  constructor(
    cards: CardView[],
    private readonly deps: BookDeps
  ) {
    this.pages = buildPages(cards);
    this.totalPages = this.pages.length;
    this.pagesPerSpread = this.mobileQuery.matches ? 1 : PAGES_PER_SPREAD;
    this.totalSpreads = this.totalPages / this.pagesPerSpread;
    deps.firstBtn.addEventListener("click", () => this.jump(0));
    deps.prevBtn.addEventListener("click", () => this.go(-1));
    deps.nextBtn.addEventListener("click", () => this.go(1));
    deps.lastBtn.addEventListener("click", () => this.jump(this.totalSpreads - 1));
    this.mobileQuery.addEventListener("change", () => this.handleModeChange());
    this.render();
  }

  private handleModeChange(): void {
    const currentPage = this.spreadIndex * this.pagesPerSpread;
    this.pagesPerSpread = this.mobileQuery.matches ? 1 : PAGES_PER_SPREAD;
    this.totalSpreads = this.totalPages / this.pagesPerSpread;
    this.spreadIndex = Math.min(Math.floor(currentPage / this.pagesPerSpread), this.totalSpreads - 1);
    this.render();
  }

  private renderPageHtml(pageIndex: number): string {
    const page = this.pages[pageIndex];
    return `<div class="book-page">${page
      .map((c) =>
        c
          ? renderCardHtml(c, "", this.deps.femaleVariantBaseNames, this.deps.formLabels)
          : `<div class="book-page-slot-empty"></div>`
      )
      .join("")}</div>`;
  }

  private render(): void {
    const left = this.spreadIndex * this.pagesPerSpread;
    const right = left + this.pagesPerSpread - 1;
    this.deps.spreadEl.innerHTML = Array.from({ length: this.pagesPerSpread }, (_, i) =>
      this.renderPageHtml(left + i)
    ).join("");
    this.deps.firstBtn.disabled = this.spreadIndex === 0;
    this.deps.prevBtn.disabled = this.spreadIndex === 0;
    this.deps.nextBtn.disabled = this.spreadIndex === this.totalSpreads - 1;
    this.deps.lastBtn.disabled = this.spreadIndex === this.totalSpreads - 1;
    this.deps.indicatorEl.textContent =
      this.pagesPerSpread === 1
        ? `Página ${left + 1} de ${this.totalPages}`
        : `Páginas ${left + 1}–${right + 1} de ${this.totalPages}`;
  }

  private go(direction: -1 | 1): void {
    const nextIndex = this.spreadIndex + direction;
    if (nextIndex < 0 || nextIndex >= this.totalSpreads) return;
    this.spreadIndex = nextIndex;
    this.flipTo(direction);
  }

  private jump(index: number): void {
    if (index < 0 || index >= this.totalSpreads || index === this.spreadIndex) return;
    const direction: -1 | 1 = index > this.spreadIndex ? 1 : -1;
    this.spreadIndex = index;
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
