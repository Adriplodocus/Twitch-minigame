import { getCollection, type CardView } from "./api";
import { collectFemaleVariantBaseNames, computeFormLabels } from "./card";
import { attachTradeLinkButton } from "./trade-link";
import { initUserHeader } from "./user-header";
import { GENERATIONS } from "./generations";
import { AlbumBook } from "./album-book";

function renderPicker(cards: CardView[]): void {
  const owned = cards.filter((c) => c.quantity > 0).length;
  document.getElementById("picker-heading")!.innerHTML =
    `Elige un álbum <span class="count">(${owned}/${cards.length})</span>`;

  const grid = document.getElementById("album-picker-grid")!;
  grid.innerHTML = GENERATIONS.map((gen) => {
    const genCards = cards.filter((c) => c.generation === gen.id);
    const genOwned = genCards.filter((c) => c.quantity > 0).length;
    return `
      <a class="album-cover" href="/album.html?gen=${gen.id}">
        <img class="album-cover-bg" src="/album-covers/${gen.id}.webp" alt="" />
        <span class="album-cover-overlay"></span>
        <span class="album-cover-content">
          <p class="album-cover-gen">
            <span class="album-cover-gen-label">Generación</span>
            <span class="album-cover-gen-number">${gen.id}</span>
          </p>
          <p class="album-cover-region">${gen.region}</p>
          <span class="album-cover-count">${genOwned}/${genCards.length}</span>
        </span>
      </a>
    `;
  }).join("");
}

function renderBook(
  cards: CardView[],
  gen: number,
  femaleVariantBaseNames: Set<string>,
  formLabels: Map<string, string>
): void {
  const genInfo = GENERATIONS.find((g) => g.id === gen)!;
  const genCards = cards.filter((c) => c.generation === gen);
  const owned = genCards.filter((c) => c.quantity > 0).length;
  document.getElementById("book-heading")!.innerHTML =
    `Generación ${genInfo.id} · ${genInfo.region} <span class="count">(${owned}/${genCards.length})</span>`;

  new AlbumBook(genCards, {
    spreadEl: document.getElementById("book-spread")!,
    prevBtn: document.getElementById("book-prev") as HTMLButtonElement,
    nextBtn: document.getElementById("book-next") as HTMLButtonElement,
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

async function load(): Promise<void> {
  const data = await getCollection();
  const femaleVariantBaseNames = collectFemaleVariantBaseNames(data.cards);
  const formLabels = computeFormLabels(data.cards);
  const gen = parseGenParam();

  const pickerEl = document.getElementById("album-picker")!;
  const bookEl = document.getElementById("album-book")!;

  if (gen === null) {
    pickerEl.style.display = "";
    bookEl.style.display = "none";
    renderPicker(data.cards);
  } else {
    pickerEl.style.display = "none";
    bookEl.style.display = "";
    renderBook(data.cards, gen, femaleVariantBaseNames, formLabels);
  }
}

attachTradeLinkButton("trade-link-btn");
initUserHeader();

load();
