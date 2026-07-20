import { getCollection, type CardView } from "./api";
import { collectFemaleVariantBaseNames, computeFormLabels, splitCardName } from "./card";
import { attachTradeLinkButton } from "./trade-link";
import { initUserHeader } from "./user-header";
import { GENERATIONS, type GenerationInfo } from "./generations";
import { AlbumBook } from "./album-book";
import { completionPercent } from "./completion-percent";

function renderGenTile(gen: GenerationInfo, genCards: CardView[], isShiny: boolean): string {
  const genOwned = genCards.filter((c) => c.quantity > 0).length;
  const shinyParam = isShiny ? "&shiny=1" : "";
  const shinyBadge = isShiny ? `<img class="album-cover-shiny-badge" src="/shiny-icon.webp" alt="" />` : "";
  return `
    <a class="album-cover${isShiny ? " album-cover-shiny" : ""}" href="/album.html?gen=${gen.id}${shinyParam}">
      <img class="album-cover-bg" src="/album-covers/${gen.id}.webp" alt="" />
      <span class="album-cover-overlay"></span>
      ${shinyBadge}
      <span class="album-cover-content">
        <p class="album-cover-gen">
          <span class="album-cover-gen-label">Generación</span>
          <span class="album-cover-gen-number">${gen.id}</span>
        </p>
        <p class="album-cover-region">${gen.region}</p>
        <span class="album-cover-count">${genOwned}/${genCards.length} · ${completionPercent(genOwned, genCards.length)}%</span>
      </span>
    </a>
  `;
}

function renderPicker(cards: CardView[]): void {
  const normalCards = cards.filter((c) => !splitCardName(c.name).isShiny);
  const shinyCards = cards.filter((c) => splitCardName(c.name).isShiny);

  const owned = normalCards.filter((c) => c.quantity > 0).length;
  document.getElementById("picker-heading")!.innerHTML =
    `Elige un álbum <span class="count">(${owned}/${normalCards.length} · ${completionPercent(owned, normalCards.length)}%)</span>`;
  document.getElementById("album-picker-grid")!.innerHTML = GENERATIONS.map((gen) =>
    renderGenTile(gen, normalCards.filter((c) => c.generation === gen.id), false)
  ).join("");

  const shinyOwned = shinyCards.filter((c) => c.quantity > 0).length;
  document.getElementById("picker-heading-shiny")!.innerHTML =
    `Shiny <span class="count">(${shinyOwned}/${shinyCards.length} · ${completionPercent(shinyOwned, shinyCards.length)}%)</span>`;
  document.getElementById("album-picker-grid-shiny")!.innerHTML = GENERATIONS.map((gen) =>
    renderGenTile(gen, shinyCards.filter((c) => c.generation === gen.id), true)
  ).join("");
}

function renderBook(
  cards: CardView[],
  gen: number,
  isShiny: boolean,
  femaleVariantBaseNames: Set<string>,
  formLabels: Map<string, string>
): void {
  const genInfo = GENERATIONS.find((g) => g.id === gen)!;
  const genCards = cards.filter((c) => c.generation === gen && splitCardName(c.name).isShiny === isShiny);
  const owned = genCards.filter((c) => c.quantity > 0).length;
  const title = isShiny ? "Álbum Shiny" : "Álbum";
  document.getElementById("book-heading")!.innerHTML =
    `${title} - Generación ${genInfo.id} · ${genInfo.region} <span class="count">(${owned}/${genCards.length} · ${completionPercent(owned, genCards.length)}%)</span>`;

  new AlbumBook(genCards, {
    spreadEl: document.getElementById("book-spread")!,
    firstBtn: document.getElementById("book-first") as HTMLButtonElement,
    prevBtn: document.getElementById("book-prev") as HTMLButtonElement,
    nextBtn: document.getElementById("book-next") as HTMLButtonElement,
    lastBtn: document.getElementById("book-last") as HTMLButtonElement,
    indicatorEl: document.getElementById("book-indicator")!,
    flipSound: document.getElementById("page-flip-sound") as HTMLAudioElement,
    femaleVariantBaseNames,
    formLabels,
  });
}

function parseGenParam(): number | null {
  const params = new URLSearchParams(window.location.search);
  const gen = Number(params.get("gen"));
  return Number.isInteger(gen) && gen >= 1 && gen <= 9 ? gen : null;
}

function parseShinyParam(): boolean {
  return new URLSearchParams(window.location.search).get("shiny") === "1";
}

async function load(): Promise<void> {
  const data = await getCollection();
  const femaleVariantBaseNames = collectFemaleVariantBaseNames(data.cards);
  const formLabels = computeFormLabels(data.cards);
  const gen = parseGenParam();
  const isShiny = parseShinyParam();

  const pickerEl = document.getElementById("album-picker")!;
  const bookEl = document.getElementById("album-book")!;

  if (gen === null) {
    pickerEl.style.display = "";
    bookEl.style.display = "none";
    renderPicker(data.cards);
  } else {
    pickerEl.style.display = "none";
    bookEl.style.display = "";
    renderBook(data.cards, gen, isShiny, femaleVariantBaseNames, formLabels);
  }
}

attachTradeLinkButton("trade-link-btn");
initUserHeader();

load();
