import { getCollection, openPack, broadcastPack, type CardView, type PendingPack } from "./api";
import { renderCardHtml, collectFemaleVariantBaseNames, computeFormLabels, compareCards, type SortField } from "./card";
import { attachTradeLinkButton } from "./trade-link";
import { initUserHeader } from "./user-header";
import { GENERATIONS } from "./generations";
import { shouldShowFoil } from "./pack-tier-foil";
import { showPackReveal } from "./pack-reveal";

let femaleVariantBaseNames = new Set<string>();
let formLabels = new Map<string, string>();
let ownedCards: CardView[] = [];

function renderOwnedGrid(): void {
  const grid = document.getElementById("owned-grid")!;
  const placeholder = document.getElementById("gen-placeholder")!;
  const genValue = (document.getElementById("gen-filter") as HTMLSelectElement).value;
  const nameQuery = (document.getElementById("name-filter") as HTMLInputElement).value.trim().toLowerCase();

  if (!genValue && !nameQuery) {
    grid.innerHTML = "";
    grid.hidden = true;
    placeholder.hidden = false;
    return;
  }
  placeholder.hidden = true;
  grid.hidden = false;

  const generation = genValue ? Number(genValue) : null;
  const field = (document.getElementById("sort-field") as HTMLSelectElement).value as SortField;
  const direction = (document.getElementById("sort-direction") as HTMLSelectElement).value;
  const sign = direction === "desc" ? -1 : 1;
  const sorted = ownedCards
    .filter((c) => (generation === null || c.generation === generation))
    .filter((c) => (!nameQuery || c.name.toLowerCase().includes(nameQuery)))
    .sort((a, b) => compareCards(a, b, field) * sign);
  grid.innerHTML = sorted.map((c) => renderCardHtml(c, "", femaleVariantBaseNames, formLabels)).join("");
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

    if (shouldShowFoil(pack.tier)) {
      const wrapper = document.createElement("div");
      wrapper.className = "pack-wrapper apoyo";
      const shine = document.createElement("div");
      shine.className = "pack-foil-shine";
      wrapper.appendChild(img);
      wrapper.appendChild(shine);
      row.appendChild(wrapper);
    } else {
      row.appendChild(img);
    }
  });
}

async function revealPack(packId: number, cards: CardView[]): Promise<void> {
  await showPackReveal(cards, () => broadcastPack(packId), femaleVariantBaseNames, formLabels);
  document.getElementById("owned-grid")!.dispatchEvent(new Event("reload-collection"));
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
    await revealPack(packId, result.cards);
    await load();
  });
}

const genFilter = document.getElementById("gen-filter") as HTMLSelectElement;
genFilter.insertAdjacentHTML(
  "beforeend",
  GENERATIONS.map((g) => `<option value="${g.id}">Gen ${g.id} · ${g.region}</option>`).join("")
);
genFilter.addEventListener("change", renderOwnedGrid);
document.getElementById("name-filter")!.addEventListener("input", renderOwnedGrid);
document.getElementById("sort-field")!.addEventListener("change", renderOwnedGrid);
document.getElementById("sort-direction")!.addEventListener("change", renderOwnedGrid);

attachTradeLinkButton("trade-link-btn");
initUserHeader();
load();
