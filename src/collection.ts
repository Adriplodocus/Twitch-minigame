import { getCollection, openPack, type CardView, type PendingPack } from "./api";

function renderCard(card: CardView): string {
  const ownedClass = card.quantity > 0 ? "" : "unowned";
  return `
    <div class="card ${ownedClass} card-in">
      <img src="${card.imagePath}" alt="${card.name}" />
      <p style="margin-top: 0.5rem; color: var(--text-em);">${card.name}</p>
      <span class="badge rarity-${card.rarity}">${card.rarity}</span>
      ${card.quantity > 0 ? `<p style="margin-top: 0.25rem;">x${card.quantity}</p>` : ""}
    </div>
  `;
}

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
  const grid = document.getElementById("card-grid")!;
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; gap: 1rem; z-index: 10;";
  document.body.appendChild(overlay);

  for (const card of cards) {
    const el = document.createElement("div");
    el.className = "card card-in";
    el.innerHTML = `<img src="${card.imagePath}" alt="${card.name}" /><p style="color: var(--text-em);">${card.name}</p><span class="badge rarity-${card.rarity}">${card.rarity}</span>`;
    overlay.appendChild(el);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  overlay.addEventListener("click", () => overlay.remove());
  grid.dispatchEvent(new Event("reload-collection"));
}

async function load(): Promise<void> {
  const data = await getCollection();
  const grid = document.getElementById("card-grid")!;
  grid.innerHTML = data.cards.map(renderCard).join("");

  renderPendingPacks(data.pendingPacks, async (packId) => {
    const result = await openPack(packId);
    await revealPack(result.cards);
    await load();
  });
}

load();
