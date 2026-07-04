import { renderCardHtml } from "./card";
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
const ALERT_DURATION_MS = 6000;
const CARD_STAGGER_MS = 1000;

let cursor = "";
const queue: OverlayEvent[] = [];
let showing = false;

function toCardView(card: OverlayEventCard): CardView {
  return { id: card.id, name: card.name, rarity: card.rarity, imagePath: card.imagePath, quantity: 1, generation: 0 };
}

function showNextAlert(): void {
  if (showing) return;
  const event = queue.shift();
  if (!event) return;
  showing = true;

  const alertEl = document.createElement("div");
  alertEl.className = "overlay-alert";
  alertEl.innerHTML = `
    <div class="overlay-alert-header">
      <img class="overlay-alert-avatar" src="${event.avatarUrl ?? "/favicon.png"}" alt="" />
      <span class="overlay-alert-username">${event.username}</span>
    </div>
    <div class="overlay-alert-cards"></div>
  `;
  document.getElementById("alerts")!.appendChild(alertEl);
  const cardsEl = alertEl.querySelector(".overlay-alert-cards")!;

  event.cards.forEach((c, i) => {
    setTimeout(() => {
      cardsEl.insertAdjacentHTML("beforeend", renderCardHtml(toCardView(c)));
    }, i * CARD_STAGGER_MS);
  });

  const totalDuration = (event.cards.length - 1) * CARD_STAGGER_MS + ALERT_DURATION_MS;
  setTimeout(() => {
    alertEl.remove();
    showing = false;
    showNextAlert();
  }, totalDuration);
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
