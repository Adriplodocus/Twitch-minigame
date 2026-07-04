import { renderCardHtml, splitCardName } from "./card";
import type { CardView } from "./api";

interface OverlayEventCard {
  id: string;
  name: string;
  rarity: CardView["rarity"];
  imagePath: string;
}

interface OverlayEvent {
  packId: number;
  broadcastAt: string;
  username: string;
  avatarUrl: string | null;
  cards: OverlayEventCard[];
}

const POLL_INTERVAL_MS = 4000;
const INTRO_DURATION_MS = 2000;
const CARD_TRANSITION_MS = 350;
const CARD_HOLD_MS = 750;
const OUTRO_DURATION_MS = 600;

let cursor = "";
const queue: OverlayEvent[] = [];
let showing = false;

function toCardView(card: OverlayEventCard): CardView {
  return { id: card.id, name: card.name, rarity: card.rarity, imagePath: card.imagePath, quantity: 1, generation: 0 };
}

function playCardSequence(container: HTMLElement, cards: OverlayEventCard[], onDone: () => void): void {
  let i = 0;

  function showCard(): void {
    const card = cards[i];
    const prev = container.querySelector<HTMLElement>(".card-slot.current");

    const slot = document.createElement("div");
    slot.className = "card-slot entering";
    slot.innerHTML = renderCardHtml(toCardView(card));
    container.appendChild(slot);
    void slot.offsetWidth;
    slot.classList.remove("entering");
    slot.classList.add("current");

    if (prev) {
      prev.classList.remove("current");
      prev.classList.add("exiting");
      prev.addEventListener("transitionend", () => prev.remove(), { once: true });
    }

    if (splitCardName(card.name).isShiny) {
      new Audio("/shiny-sound.mp3").play().catch(() => {});
    }

    i++;
    setTimeout(i < cards.length ? showCard : onDone, CARD_TRANSITION_MS + CARD_HOLD_MS);
  }

  showCard();
}

function showNextAlert(): void {
  if (showing) return;
  const event = queue.shift();
  if (!event) return;
  showing = true;

  new Audio("/Opening.mp3").play().catch(() => {});

  const alertEl = document.createElement("div");
  alertEl.className = "overlay-alert";
  alertEl.innerHTML = `
    <div class="overlay-intro">
      <span class="overlay-intro-username">${event.username}</span>
      <span class="overlay-intro-text">acaba de abrir un sobre de cromos Pokémon</span>
    </div>
    <div class="overlay-header">
      <span class="overlay-header-username">${event.username}</span>
    </div>
    <div class="overlay-cards"></div>
  `;
  document.getElementById("alerts")!.appendChild(alertEl);

  const introEl = alertEl.querySelector<HTMLElement>(".overlay-intro")!;
  const headerEl = alertEl.querySelector<HTMLElement>(".overlay-header")!;
  const cardsEl = alertEl.querySelector<HTMLElement>(".overlay-cards")!;

  requestAnimationFrame(() => introEl.classList.add("visible"));

  setTimeout(() => {
    introEl.remove();
    headerEl.classList.add("visible");
    cardsEl.classList.add("active");
    playCardSequence(cardsEl, event.cards, () => {
      alertEl.classList.add("fade-out");
      setTimeout(() => {
        alertEl.remove();
        showing = false;
        showNextAlert();
      }, OUTRO_DURATION_MS);
    });
  }, INTRO_DURATION_MS);
}

async function poll(): Promise<void> {
  try {
    const res = await fetch(`/api/overlay/events?since=${encodeURIComponent(cursor)}`);
    if (!res.ok) return;
    const data = (await res.json()) as { events: OverlayEvent[]; cursor: string };
    cursor = data.cursor;
    queue.push(...data.events);
    showNextAlert();
  } catch {
    // ignore, retry on the next interval
  }
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
