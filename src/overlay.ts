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
const HYPE_HOLD_BONUS_MS = 400;
const OUTRO_DURATION_MS = 600;
const CONFETTI_COUNT = 18;
const CONFETTI_COLORS = ["var(--gold)", "var(--pink)", "var(--blue)"];
const CONFETTI_DURATION_MS = 1200;
const SHAKE_DURATION_MS = 300;

let cursor = "";
const queue: OverlayEvent[] = [];
let showing = false;

function toCardView(card: OverlayEventCard): CardView {
  return { id: card.id, name: card.name, rarity: card.rarity, imagePath: card.imagePath, quantity: 1, generation: 0 };
}

function hypeKind(card: OverlayEventCard): "legendary" | "shiny" | null {
  if (card.rarity === "legendary") return "legendary";
  if (splitCardName(card.name).isShiny) return "shiny";
  return null;
}

function spawnConfetti(slot: HTMLElement): void {
  for (let i = 0; i < CONFETTI_COUNT; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 120}px`);
    piece.style.setProperty("--spin", `${Math.random() > 0.5 ? 1 : -1}`);
    piece.style.animationDelay = `${Math.random() * 150}ms`;
    slot.appendChild(piece);
  }
  setTimeout(() => slot.querySelectorAll(".confetti-piece").forEach((p) => p.remove()), CONFETTI_DURATION_MS);
}

function shakeAlert(alertEl: HTMLElement): void {
  alertEl.classList.add("shake");
  setTimeout(() => alertEl.classList.remove("shake"), SHAKE_DURATION_MS);
}

function playCardSequence(
  alertEl: HTMLElement,
  container: HTMLElement,
  cards: OverlayEventCard[],
  onDone: () => void,
): void {
  let i = 0;

  function showCard(): void {
    const card = cards[i];
    const kind = hypeKind(card);
    const prev = container.querySelector<HTMLElement>(".card-slot.current");

    const slot = document.createElement("div");
    slot.className = kind ? `card-slot entering hype hype-${kind}` : "card-slot entering";
    slot.innerHTML = renderCardHtml(toCardView(card));
    container.appendChild(slot);
    container.style.height = `${slot.offsetHeight}px`;
    void slot.offsetWidth;
    slot.classList.remove("entering");
    slot.classList.add("current");

    if (prev) {
      prev.classList.remove("current");
      prev.classList.add("exiting");
      prev.addEventListener("transitionend", () => prev.remove(), { once: true });
    }

    if (kind === "shiny") {
      new Audio("/shiny-sound.mp3").play().catch(() => {});
    }
    if (kind) {
      spawnConfetti(slot);
      shakeAlert(alertEl);
    }

    i++;
    const hold = CARD_TRANSITION_MS + CARD_HOLD_MS + (kind ? HYPE_HOLD_BONUS_MS : 0);
    setTimeout(i < cards.length ? showCard : onDone, hold);
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
      ${event.avatarUrl ? `<img class="overlay-intro-avatar" src="${event.avatarUrl}" alt="" />` : ""}
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
    playCardSequence(alertEl, cardsEl, event.cards, () => {
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
