import { getCollection, openPack, type CardView, type PendingPack } from "./api";
import { renderCardHtml, collectFemaleVariantBaseNames, computeFormLabels, splitCardName, compareCards, type SortField } from "./card";
import { attachTradeLinkButton } from "./trade-link";
import { initUserHeader } from "./user-header";
import { GENERATIONS } from "./generations";

let femaleVariantBaseNames = new Set<string>();
let formLabels = new Map<string, string>();
let ownedCards: CardView[] = [];

function renderOwnedGrid(): void {
  const field = (document.getElementById("sort-field") as HTMLSelectElement).value as SortField;
  const direction = (document.getElementById("sort-direction") as HTMLSelectElement).value;
  const sign = direction === "desc" ? -1 : 1;
  const sorted = [...ownedCards].sort((a, b) => compareCards(a, b, field) * sign);
  document.getElementById("owned-grid")!.innerHTML = sorted
    .map((c) => renderCardHtml(c, "", femaleVariantBaseNames, formLabels))
    .join("");
}

function openAlbumPickerModal(): Promise<number | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <h3>¿De qué álbum quieres abrir el sobre?</h3>
        <div class="modal-gen-grid">
          ${GENERATIONS.map(
            (g) => `<button type="button" class="btn modal-gen-btn" data-gen="${g.id}">Gen ${g.id} · ${g.region}</button>`
          ).join("")}
        </div>
        <button type="button" class="btn modal-cancel-btn">Cancelar</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const genBtn = target.closest<HTMLElement>(".modal-gen-btn");
      if (genBtn) {
        overlay.remove();
        resolve(Number(genBtn.dataset.gen));
        return;
      }
      if (target.closest(".modal-cancel-btn") || target === overlay) {
        overlay.remove();
        resolve(null);
      }
    });
  });
}

function renderPendingPacks(packs: PendingPack[], onOpen: (id: number, generation: number) => Promise<void>): void {
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
    img.addEventListener("click", async () => {
      const generation = await openAlbumPickerModal();
      if (generation === null) return;
      img.classList.add("opening");
      onOpen(pack.id, generation).finally(() => {
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
    `Cromos obtenidos <span class="count">(${ownedCards.length}/${data.cards.length})</span>`;
  renderOwnedGrid();

  renderPendingPacks(data.pendingPacks, async (packId, generation) => {
    const result = await openPack(packId, generation);
    await revealPack(result.cards);
    await load();
  });
}

document.getElementById("sort-field")!.addEventListener("change", renderOwnedGrid);
document.getElementById("sort-direction")!.addEventListener("change", renderOwnedGrid);

attachTradeLinkButton("trade-link-btn");
initUserHeader();
load();
