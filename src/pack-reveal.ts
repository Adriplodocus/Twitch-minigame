import { renderCardHtml, splitCardName } from "./card";
import type { CardView } from "./api";
import { playSound } from "./sound-pref";

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
    const soundsPlaying: Promise<void>[] = [];
    if (cards[i].rarity === "legendary") {
      soundsPlaying.push(playSound(`/cries/${Math.floor((cards[i].sortOrder ?? 0) / 1_000_000)}.ogg`));
    }
    if (splitCardName(cards[i].name).isShiny) {
      soundsPlaying.push(playSound("/shiny-sound.mp3"));
    }
    await Promise.all([new Promise((resolve) => setTimeout(resolve, 400)), ...soundsPlaying]);
  }

  const buttonsRow = document.createElement("div");
  buttonsRow.style.cssText = "display: flex; gap: 0.75rem; align-items: flex-start;";

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

  const broadcastCol = document.createElement("div");
  broadcastCol.style.cssText = "display: flex; flex-direction: column; align-items: center; gap: 0.4rem;";

  const broadcastHint = document.createElement("p");
  broadcastHint.style.cssText = "color: var(--muted); font-size: 0.75rem; text-align: center; max-width: 220px;";
  broadcastHint.textContent = "Envía una alerta en el stream de MrKlypp con las cartas obtenidas";

  broadcastCol.appendChild(broadcastBtn);
  broadcastCol.appendChild(broadcastHint);

  buttonsRow.appendChild(closeBtn);
  buttonsRow.appendChild(broadcastCol);
  overlay.appendChild(buttonsRow);
}
