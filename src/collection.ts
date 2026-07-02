import { getCollection, openPack, type CardView, type PendingPack } from "./api";
import { renderCardHtml, collectFemaleVariantBaseNames, computeFormLabels } from "./card";

let femaleVariantBaseNames = new Set<string>();
let formLabels = new Map<string, string>();

function renderPendingPacks(packs: PendingPack[], onOpen: (id: number) => void): void {
  const container = document.getElementById("pending-packs")!;
  if (packs.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `<h2>Sobres pendientes (${packs.length})</h2>`;
  for (const pack of packs) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.style.marginTop = "0.75rem";
    btn.textContent = `Abrir sobre #${pack.id}`;
    btn.addEventListener("click", () => onOpen(pack.id));
    container.appendChild(btn);
  }
}

async function revealPack(cards: CardView[]): Promise<void> {
  const grid = document.getElementById("owned-grid")!;
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; gap: 1rem; z-index: 10;";
  document.body.appendChild(overlay);

  for (const card of cards) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderCardHtml(card, "", femaleVariantBaseNames, formLabels);
    overlay.appendChild(wrapper.firstElementChild!);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  overlay.addEventListener("click", () => overlay.remove());
  grid.dispatchEvent(new Event("reload-collection"));
}

async function load(): Promise<void> {
  const data = await getCollection();
  femaleVariantBaseNames = collectFemaleVariantBaseNames(data.cards);
  formLabels = computeFormLabels(data.cards);
  const owned = data.cards.filter((c) => c.quantity > 0);
  const unowned = data.cards.filter((c) => c.quantity === 0);

  document.getElementById("owned-heading")!.innerHTML =
    `Obtenidas <span class="count">(${owned.length}/${data.cards.length})</span>`;
  document.getElementById("owned-grid")!.innerHTML = owned
    .map((c) => renderCardHtml(c, "", femaleVariantBaseNames, formLabels))
    .join("");

  document.getElementById("unowned-heading")!.innerHTML = `Por conseguir <span class="count">(${unowned.length})</span>`;
  document.getElementById("unowned-grid")!.innerHTML = unowned
    .map((c) => renderCardHtml(c, "", femaleVariantBaseNames, formLabels))
    .join("");

  renderPendingPacks(data.pendingPacks, async (packId) => {
    const result = await openPack(packId);
    await revealPack(result.cards);
    await load();
  });
}

load();
