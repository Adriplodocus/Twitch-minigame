import { renderCardHtml, splitCardName } from "./card";
import type { CardView } from "./api";
import { isMuted } from "./sound-pref";

function preloadImage(src: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = src;
  });
}

export async function showPackReveal(
  cards: CardView[],
  onBroadcast: () => Promise<void>,
  femaleVariantBaseNames?: Set<string>,
  formLabels?: Map<string, string>
): Promise<void> {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position: fixed; inset: 0; background: rgba(59,46,34,0.80); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5rem; z-index: 10; padding: 1rem; overflow-y: auto;";
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
    if (!isMuted() && cards[i].rarity === "legendary") {
      new Audio(`/cries/${Math.floor((cards[i].sortOrder ?? 0) / 1_000_000)}.ogg`).play().catch(() => {});
    }
    if (!isMuted() && splitCardName(cards[i].name).isShiny) {
      new Audio("/shiny-sound.mp3").play().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const buttonsRow = document.createElement("div");
  buttonsRow.style.cssText = "display: flex; gap: 0.75rem;";

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = "Cerrar";
  closeBtn.addEventListener("click", () => overlay.remove());

  const broadcastBtn = document.createElement("button");
  broadcastBtn.className = "btn";
  broadcastBtn.textContent = "Cerrar y mostrar en stream";
  broadcastBtn.addEventListener("click", async () => {
    broadcastBtn.disabled = true;
    try {
      await onBroadcast();
      overlay.remove();
    } catch {
      broadcastBtn.disabled = false;
      broadcastBtn.textContent = "Error, reintentar";
    }
  });

  buttonsRow.appendChild(closeBtn);
  buttonsRow.appendChild(broadcastBtn);
  overlay.appendChild(buttonsRow);
}
