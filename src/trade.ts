import { getCollection, getUserCollection, createOffer, getMe, type CardView } from "./api";
import { initUserHeader } from "./user-header";
import {
  renderCardHtml,
  collectFemaleVariantBaseNames,
  computeFormLabels,
  compareCards,
  filterCardsByName,
  type SortField,
} from "./card";

let currentTargetUsername = "";
let myCards: CardView[] = [];
let targetCards: CardView[] = [];
let myFemaleVariants = new Set<string>();
let targetFemaleVariants = new Set<string>();
let myFormLabels = new Map<string, string>();
let targetFormLabels = new Map<string, string>();
const offerQuantities = new Map<string, number>();
const requestQuantities = new Map<string, number>();

function renderSelectableCard(
  card: CardView,
  inputClass: string,
  quantities: Map<string, number>,
  femaleVariantBaseNames: Set<string>,
  formLabels: Map<string, string>
): string {
  if (card.quantity === 0) return "";
  const value = quantities.get(card.id) ?? 0;
  const input = `
    <input
      type="number"
      class="input ${inputClass}"
      data-card-id="${card.id}"
      min="0"
      max="${card.quantity}"
      value="${value}"
      style="margin-top: 0.5rem; width: 100%;"
    />
  `;
  return renderCardHtml(card, input, femaleVariantBaseNames, formLabels);
}

function renderTargetGrid(): void {
  const field = (document.getElementById("target-sort-field") as HTMLSelectElement).value as SortField;
  const direction = (document.getElementById("target-sort-direction") as HTMLSelectElement).value;
  const sign = direction === "desc" ? -1 : 1;
  const query = (document.getElementById("target-filter") as HTMLInputElement).value;
  const filtered = filterCardsByName(targetCards, query).sort((a, b) => compareCards(a, b, field) * sign);
  document.getElementById("target-collection")!.innerHTML = filtered
    .map((c) => renderSelectableCard(c, "request-qty", requestQuantities, targetFemaleVariants, targetFormLabels))
    .join("");
}

function renderMyGrid(): void {
  const field = (document.getElementById("sort-field") as HTMLSelectElement).value as SortField;
  const direction = (document.getElementById("sort-direction") as HTMLSelectElement).value;
  const sign = direction === "desc" ? -1 : 1;
  const query = (document.getElementById("my-filter") as HTMLInputElement).value;
  const filtered = filterCardsByName(myCards, query).sort((a, b) => compareCards(a, b, field) * sign);
  document.getElementById("my-cards")!.innerHTML = filtered
    .map((c) => renderSelectableCard(c, "offer-qty", offerQuantities, myFemaleVariants, myFormLabels))
    .join("");
}

function trackQuantity(e: Event, inputClass: string, quantities: Map<string, number>): void {
  const target = e.target as HTMLElement;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains(inputClass)) return;
  const cardId = target.dataset.cardId!;
  const value = Number(target.value);
  if (value > 0) quantities.set(cardId, value);
  else quantities.delete(cardId);
}

function quantitiesToItems(quantities: Map<string, number>): { cardId: string; quantity: number }[] {
  return Array.from(quantities, ([cardId, quantity]) => ({ cardId, quantity }));
}

function showError(message: string): void {
  const errorEl = document.getElementById("trade-error")!;
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

async function init(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const targetUsername = params.get("with");
  if (!targetUsername) {
    showError("Falta el usuario con quien comerciar. Pídele a alguien su enlace de trade.");
    return;
  }

  const me = await getMe();
  if (me.username === targetUsername) {
    showError("No puedes intercambiar contigo mismo.");
    return;
  }

  const myCollection = await getCollection();
  myCards = myCollection.cards;

  let target: { username: string; cards: CardView[] };
  try {
    target = await getUserCollection(targetUsername);
  } catch {
    showError(`No se encontró a ${targetUsername}.`);
    return;
  }
  targetCards = target.cards;
  currentTargetUsername = targetUsername;

  document.getElementById("trade-heading")!.textContent = `Intercambio con ${targetUsername}`;
  document.getElementById("target-heading")!.textContent = `Cartas de ${targetUsername}`;

  myFemaleVariants = collectFemaleVariantBaseNames(myCards);
  targetFemaleVariants = collectFemaleVariantBaseNames(targetCards);
  myFormLabels = computeFormLabels(myCards);
  targetFormLabels = computeFormLabels(targetCards);

  renderTargetGrid();
  renderMyGrid();
  document.getElementById("offer-builder")!.style.display = "block";
}

async function sendOffer(): Promise<void> {
  if (!currentTargetUsername) return;
  const offerCards = quantitiesToItems(offerQuantities);
  const requestCards = quantitiesToItems(requestQuantities);
  if (offerCards.length === 0 && requestCards.length === 0) return;

  await createOffer({ toUsername: currentTargetUsername, offerCards, requestCards });
  window.location.href = "/offers.html";
}

document.getElementById("target-filter")!.addEventListener("input", renderTargetGrid);
document.getElementById("target-sort-field")!.addEventListener("change", renderTargetGrid);
document.getElementById("target-sort-direction")!.addEventListener("change", renderTargetGrid);
document.getElementById("sort-field")!.addEventListener("change", renderMyGrid);
document.getElementById("sort-direction")!.addEventListener("change", renderMyGrid);
document.getElementById("my-filter")!.addEventListener("input", renderMyGrid);
document.getElementById("target-collection")!.addEventListener("input", (e) => trackQuantity(e, "request-qty", requestQuantities));
document.getElementById("my-cards")!.addEventListener("input", (e) => trackQuantity(e, "offer-qty", offerQuantities));
document.getElementById("send-offer-btn")!.addEventListener("click", sendOffer);
initUserHeader();

init();
