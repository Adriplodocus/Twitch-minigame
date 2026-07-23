import { getCollection, getUserCollection, createOffer, getMe, getMarketplaceDemand, type CardView } from "./api";
import { initUserHeader } from "./user-header";
import {
  renderCardHtml,
  collectFemaleVariantBaseNames,
  computeFormLabels,
  compareCards,
  filterCardsByName,
  type SortField,
} from "./card";
import { GENERATIONS } from "./generations";
import { completionPercent } from "./completion-percent";

let currentTargetUsername = "";
let currentMarketplaceDemandId: number | null = null;
let lockedDemandCardId: string | null = null;
let myCards: CardView[] = [];
let targetCards: CardView[] = [];
let myFemaleVariants = new Set<string>();
let targetFemaleVariants = new Set<string>();
let myFormLabels = new Map<string, string>();
let targetFormLabels = new Map<string, string>();
const offerQuantities = new Map<string, number>();
const requestQuantities = new Map<string, number>();
let myQuantityById = new Map<string, number>();

type TargetSortField = "pokedex" | "toGet" | "quantity";

// "toGet" isn't a generic SortField: it needs my own ownership (myQuantityById),
// not the target's, so it's handled separately from card.ts's compareCards.
// Cards I don't have always come first regardless of asc/desc; only the
// quantity/generation tie-break within each group flips with sign.
function compareTargetCards(a: CardView, b: CardView, field: TargetSortField, sign: number): number {
  if (field === "toGet") {
    const aOwned = (myQuantityById.get(a.id) ?? 0) > 0;
    const bOwned = (myQuantityById.get(b.id) ?? 0) > 0;
    if (aOwned !== bOwned) return aOwned ? 1 : -1;
    return (a.quantity - b.quantity || b.generation - a.generation) * sign;
  }
  return compareCards(a, b, field) * sign;
}

function renderSelectableCard(
  card: CardView,
  inputClass: string,
  quantities: Map<string, number>,
  femaleVariantBaseNames: Set<string>,
  formLabels: Map<string, string>
): string {
  if (card.quantity === 0) return "";
  const isLocked = inputClass === "offer-qty" && card.id === lockedDemandCardId;
  const value = isLocked ? 1 : quantities.get(card.id) ?? 0;
  const input = `
    <input
      type="number"
      class="input ${inputClass}"
      data-card-id="${card.id}"
      min="${isLocked ? 1 : 0}"
      max="${isLocked ? 1 : card.quantity}"
      value="${value}"
      style="margin-top: 0.5rem; width: 100%;"
      ${isLocked ? "disabled" : ""}
    />
  `;

  if (inputClass === "request-qty") {
    // Grayscale should reflect whether *I* own this card, not whether the
    // target does (the grid only lists cards the target already has), so
    // swap in my own quantity for ownership/VFX while keeping the target's
    // real quantity in the badge.
    const displayCard: CardView = { ...card, quantity: myQuantityById.get(card.id) ?? 0 };
    return renderCardHtml(displayCard, input, femaleVariantBaseNames, formLabels, true, `<span class="card-qty">x${card.quantity}</span>`);
  }

  return renderCardHtml(card, input, femaleVariantBaseNames, formLabels);
}

function renderGenFilterOptions(selectId: string, cards: CardView[]): void {
  const genFilter = document.getElementById(selectId) as HTMLSelectElement;
  const previousValue = genFilter.value;
  const optionsHtml = GENERATIONS.map((g) => {
    const genCards = cards.filter((c) => c.generation === g.id);
    const genOwned = genCards.filter((c) => c.quantity > 0).length;
    const pct = completionPercent(genOwned, genCards.length);
    return `<option value="${g.id}">Gen ${g.id} · ${g.region} (${genOwned}/${genCards.length} · ${pct}%)</option>`;
  }).join("");
  genFilter.innerHTML = `<option value="">Todas</option>${optionsHtml}`;
  genFilter.value = previousValue;
}

function renderTargetGrid(): void {
  const field = (document.getElementById("target-sort-field") as HTMLSelectElement).value as TargetSortField;
  const direction = (document.getElementById("target-sort-direction") as HTMLSelectElement).value;
  const sign = direction === "desc" ? -1 : 1;
  const genValue = (document.getElementById("target-gen-filter") as HTMLSelectElement).value;
  const generation = genValue ? Number(genValue) : null;
  const query = (document.getElementById("target-filter") as HTMLInputElement).value;
  const filtered = filterCardsByName(targetCards, query)
    .filter((c) => generation === null || c.generation === generation)
    .sort((a, b) => compareTargetCards(a, b, field, sign));
  document.getElementById("target-collection")!.innerHTML = filtered
    .map((c) => renderSelectableCard(c, "request-qty", requestQuantities, targetFemaleVariants, targetFormLabels))
    .join("");
}

function renderMyGrid(): void {
  const field = (document.getElementById("sort-field") as HTMLSelectElement).value as SortField;
  const direction = (document.getElementById("sort-direction") as HTMLSelectElement).value;
  const sign = direction === "desc" ? -1 : 1;
  const genValue = (document.getElementById("my-gen-filter") as HTMLSelectElement).value;
  const generation = genValue ? Number(genValue) : null;
  const query = (document.getElementById("my-filter") as HTMLInputElement).value;
  const filtered = filterCardsByName(myCards, query)
    .filter((c) => generation === null || c.generation === generation)
    .sort((a, b) => compareCards(a, b, field) * sign);
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
  const demandIdParam = params.get("demandId");

  let targetUsername = params.get("with");

  if (demandIdParam) {
    try {
      const demand = await getMarketplaceDemand(Number(demandIdParam));
      targetUsername = demand.creatorUsername;
      lockedDemandCardId = demand.demand.cardId;
      currentMarketplaceDemandId = Number(demandIdParam);
    } catch {
      showError("Esta demanda ya no está disponible.");
      return;
    }
  }

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
  myQuantityById = new Map(myCards.map((c) => [c.id, c.quantity]));

  let target: { username: string; cards: CardView[] };
  try {
    target = await getUserCollection(targetUsername);
  } catch {
    showError(`No se encontró a ${targetUsername}.`);
    return;
  }
  targetCards = target.cards;
  currentTargetUsername = targetUsername;

  if (lockedDemandCardId) offerQuantities.set(lockedDemandCardId, 1);

  document.getElementById("trade-heading")!.textContent = `Intercambio con ${targetUsername}`;
  document.getElementById("target-heading")!.textContent = `Cartas de ${targetUsername}`;

  myFemaleVariants = collectFemaleVariantBaseNames(myCards);
  targetFemaleVariants = collectFemaleVariantBaseNames(targetCards);
  myFormLabels = computeFormLabels(myCards);
  targetFormLabels = computeFormLabels(targetCards);

  renderGenFilterOptions("target-gen-filter", targetCards);
  renderGenFilterOptions("my-gen-filter", myCards);

  renderTargetGrid();
  if (lockedDemandCardId) {
    document.getElementById("my-cards-section")!.style.display = "none";
  } else {
    renderMyGrid();
  }
  document.getElementById("offer-builder")!.style.display = "block";
}

async function sendOffer(): Promise<void> {
  if (!currentTargetUsername) return;
  const offerCards = quantitiesToItems(offerQuantities);
  const requestCards = quantitiesToItems(requestQuantities);
  if (offerCards.length === 0 && requestCards.length === 0) return;

  await createOffer({
    toUsername: currentTargetUsername,
    offerCards,
    requestCards,
    ...(currentMarketplaceDemandId !== null ? { marketplaceDemandId: currentMarketplaceDemandId } : {}),
  });
  window.location.href = "/offers.html";
}

function wireNameFilterClear(inputId: string, clearId: string, render: () => void): void {
  const input = document.getElementById(inputId) as HTMLInputElement;
  const clearBtn = document.getElementById(clearId) as HTMLButtonElement;
  input.addEventListener("input", () => {
    clearBtn.hidden = input.value.length === 0;
    render();
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.hidden = true;
    render();
  });
}

document.getElementById("target-sort-field")!.addEventListener("change", (e) => {
  const field = (e.target as HTMLSelectElement).value as TargetSortField;
  if (field === "toGet") {
    (document.getElementById("target-sort-direction") as HTMLSelectElement).value = "desc";
  }
  renderTargetGrid();
});
document.getElementById("target-sort-direction")!.addEventListener("change", renderTargetGrid);
document.getElementById("target-gen-filter")!.addEventListener("change", renderTargetGrid);
wireNameFilterClear("target-filter", "target-filter-clear", renderTargetGrid);
document.getElementById("sort-field")!.addEventListener("change", renderMyGrid);
document.getElementById("sort-direction")!.addEventListener("change", renderMyGrid);
document.getElementById("my-gen-filter")!.addEventListener("change", renderMyGrid);
wireNameFilterClear("my-filter", "my-filter-clear", renderMyGrid);
document.getElementById("target-collection")!.addEventListener("input", (e) => trackQuantity(e, "request-qty", requestQuantities));
document.getElementById("my-cards")!.addEventListener("input", (e) => trackQuantity(e, "offer-qty", offerQuantities));
document.getElementById("send-offer-btn")!.addEventListener("click", sendOffer);
initUserHeader();

init();
