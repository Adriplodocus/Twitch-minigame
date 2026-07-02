import { getCollection, type CardView } from "./api";

function renderCard(card: CardView): string {
  const ownedClass = card.quantity > 0 ? "" : "unowned";
  return `
    <div class="card ${ownedClass} card-in">
      <img src="${card.imagePath}" alt="${card.name}" loading="lazy" />
      <p style="margin-top: 0.5rem; color: var(--text-em);">${card.name}</p>
      <span class="badge rarity-${card.rarity}">${card.rarity}</span>
      ${card.quantity > 0 ? `<p style="margin-top: 0.25rem;">x${card.quantity}</p>` : ""}
    </div>
  `;
}

async function load(): Promise<void> {
  const data = await getCollection();
  const owned = data.cards.filter((c: CardView) => c.quantity > 0).length;

  document.getElementById("album-heading")!.innerHTML =
    `Pokédex <span class="count">(${owned}/${data.cards.length})</span>`;
  document.getElementById("album-grid")!.innerHTML = data.cards.map(renderCard).join("");
}

load();
