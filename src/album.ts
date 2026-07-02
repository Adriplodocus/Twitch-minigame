import { getCollection, type CardView } from "./api";
import { renderCardHtml, collectFemaleVariantBaseNames, computeFormLabels } from "./card";

async function load(): Promise<void> {
  const data = await getCollection();
  const femaleVariantBaseNames = collectFemaleVariantBaseNames(data.cards);
  const formLabels = computeFormLabels(data.cards);
  const owned = data.cards.filter((c: CardView) => c.quantity > 0).length;

  document.getElementById("album-heading")!.innerHTML =
    `Pokédex <span class="count">(${owned}/${data.cards.length})</span>`;
  document.getElementById("album-grid")!.innerHTML = data.cards
    .map((c) => renderCardHtml(c, "", femaleVariantBaseNames, formLabels))
    .join("");
}

load();
