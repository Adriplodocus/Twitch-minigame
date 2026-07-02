import { getCollection, openPack, logout, type CardView, type PendingPack } from "./api";
import { renderCardHtml, collectFemaleVariantBaseNames, computeFormLabels, splitCardName } from "./card";

let femaleVariantBaseNames = new Set<string>();
let formLabels = new Map<string, string>();
let ownedCards: CardView[] = [];

type SortField = "pokedex" | "recent" | "quantity";

function compareCards(a: CardView, b: CardView, field: SortField): number {
  switch (field) {
    case "pokedex":
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    case "recent":
      return (a.acquiredAt ?? "").localeCompare(b.acquiredAt ?? "");
    case "quantity":
      return a.quantity - b.quantity;
  }
}

function renderOwnedGrid(): void {
  const field = (document.getElementById("sort-field") as HTMLSelectElement).value as SortField;
  const direction = (document.getElementById("sort-direction") as HTMLSelectElement).value;
  const sign = direction === "desc" ? -1 : 1;
  const sorted = [...ownedCards].sort((a, b) => compareCards(a, b, field) * sign);
  document.getElementById("owned-grid")!.innerHTML = sorted
    .map((c) => renderCardHtml(c, "", femaleVariantBaseNames, formLabels))
    .join("");
}

function renderPendingPacks(packs: PendingPack[], onOpen: (id: number) => Promise<void>): void {
  const container = document.getElementById("pending-packs")!;
  if (packs.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `<h2>Sobres pendientes (${packs.length})</h2>`;
  const row = document.createElement("div");
  row.style.cssText = "display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.75rem;";
  container.appendChild(row);

  packs.forEach((pack, index) => {
    const img = document.createElement("img");
    img.className = "pack-open-img";
    img.src = "/pack.webp";
    img.alt = "Abrir sobre";
    img.style.animationDelay = `-${(index * 0.7) % 2.4}s`;
    img.addEventListener("click", () => {
      img.classList.add("opening");
      onOpen(pack.id).finally(() => {
        img.classList.remove("opening");
      });
    });
    row.appendChild(img);
  });
}

function preloadImage(src: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = src;
  });
}

async function revealPack(cards: CardView[]): Promise<void> {
  const grid = document.getElementById("owned-grid")!;
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position: fixed; inset: 0; background: rgba(59,46,34,0.80); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5rem; z-index: 10; padding: 1rem;";
  document.body.appendChild(overlay);

  const cardsRow = document.createElement("div");
  cardsRow.style.cssText = "display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 1rem;";
  overlay.appendChild(cardsRow);

  const preloads = cards.map((c) => preloadImage(c.imagePath));

  for (let i = 0; i < cards.length; i++) {
    await preloads[i];
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderCardHtml(cards[i], "", femaleVariantBaseNames, formLabels);
    const cardEl = wrapper.firstElementChild!;
    cardEl.classList.add("card-reveal");
    cardsRow.appendChild(cardEl);
    if (splitCardName(cards[i].name).isShiny) {
      new Audio("/shiny-sound.mp3").play().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = "Cerrar";
  closeBtn.addEventListener("click", () => overlay.remove());
  overlay.appendChild(closeBtn);

  grid.dispatchEvent(new Event("reload-collection"));
}

async function load(): Promise<void> {
  const data = await getCollection();
  femaleVariantBaseNames = collectFemaleVariantBaseNames(data.cards);
  formLabels = computeFormLabels(data.cards);
  ownedCards = data.cards.filter((c) => c.quantity > 0);

  document.getElementById("owned-heading")!.innerHTML =
    `Obtenidas <span class="count">(${ownedCards.length}/${data.cards.length})</span>`;
  renderOwnedGrid();

  renderPendingPacks(data.pendingPacks, async (packId) => {
    const result = await openPack(packId);
    await revealPack(result.cards);
    await load();
  });
}

document.getElementById("sort-field")!.addEventListener("change", renderOwnedGrid);
document.getElementById("sort-direction")!.addEventListener("change", renderOwnedGrid);
document.getElementById("logout-btn")!.addEventListener("click", async () => {
  await logout();
  window.location.href = "/";
});

load();
