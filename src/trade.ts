import {
  getCollection,
  getUserCollection,
  listOffers,
  createOffer,
  acceptOffer,
  declineOffer,
  cancelOffer,
  type CardView,
  type TradeOfferItem,
  type TradeOfferSummary,
} from "./api";
import { renderCardHtml, collectFemaleVariantBaseNames, computeFormLabels } from "./card";

let currentTargetUsername = "";

function renderSelectableCard(
  card: CardView,
  inputClass: string,
  femaleVariantBaseNames: Set<string>,
  formLabels: Map<string, string>
): string {
  if (card.quantity === 0) return "";
  const input = `
    <input
      type="number"
      class="input ${inputClass}"
      data-card-id="${card.id}"
      min="0"
      max="${card.quantity}"
      value="0"
      style="margin-top: 0.5rem; width: 100%;"
    />
  `;
  return renderCardHtml(card, input, femaleVariantBaseNames, formLabels);
}

function collectQuantities(containerId: string, inputClass: string): { cardId: string; quantity: number }[] {
  const container = document.getElementById(containerId)!;
  const inputs = container.querySelectorAll<HTMLInputElement>(`.${inputClass}`);
  const result: { cardId: string; quantity: number }[] = [];
  inputs.forEach((input) => {
    const quantity = Number(input.value);
    if (quantity > 0) result.push({ cardId: input.dataset.cardId!, quantity });
  });
  return result;
}

async function searchUser(): Promise<void> {
  const input = document.getElementById("search-username") as HTMLInputElement;
  currentTargetUsername = input.value.trim();
  if (!currentTargetUsername) return;

  const [myCollection, targetCollection] = await Promise.all([
    getCollection(),
    getUserCollection(currentTargetUsername),
  ]);

  const myFemaleVariants = collectFemaleVariantBaseNames(myCollection.cards);
  const targetFemaleVariants = collectFemaleVariantBaseNames(targetCollection.cards);
  const myFormLabels = computeFormLabels(myCollection.cards);
  const targetFormLabels = computeFormLabels(targetCollection.cards);

  document.getElementById("my-cards")!.innerHTML = myCollection.cards
    .map((card) => renderSelectableCard(card, "offer-qty", myFemaleVariants, myFormLabels))
    .join("");
  document.getElementById("target-collection")!.innerHTML = targetCollection.cards
    .map((card) => renderSelectableCard(card, "request-qty", targetFemaleVariants, targetFormLabels))
    .join("");
  document.getElementById("offer-builder")!.style.display = "block";
}

async function sendOffer(): Promise<void> {
  if (!currentTargetUsername) return;
  const offerCards = collectQuantities("my-cards", "offer-qty");
  const requestCards = collectQuantities("target-collection", "request-qty");
  if (offerCards.length === 0 && requestCards.length === 0) return;

  await createOffer({ toUsername: currentTargetUsername, offerCards, requestCards });
  document.getElementById("offer-builder")!.style.display = "none";
  await loadOffers();
}

function renderOfferItems(items: TradeOfferItem[], side: "from" | "to"): string {
  const filtered = items.filter((item) => item.side === side);
  if (filtered.length === 0) return `<p style="color: var(--dim);">— nada —</p>`;
  return `<div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">${filtered
    .map((item) => renderCardHtml({ id: item.cardId, name: item.name, rarity: item.rarity, imagePath: item.imagePath, quantity: item.quantity }))
    .join("")}</div>`;
}

function renderOffer(offer: TradeOfferSummary, kind: "sent" | "received"): string {
  const label = kind === "sent" ? `Para: ${offer.toUser}` : `De: ${offer.fromUser}`;
  const actions =
    kind === "received" && offer.status === "pending"
      ? `<button class="btn accept-btn" data-id="${offer.id}">Aceptar</button>
         <button class="btn decline-btn" data-id="${offer.id}">Rechazar</button>`
      : kind === "sent" && offer.status === "pending"
        ? `<button class="btn cancel-btn" data-id="${offer.id}">Cancelar</button>`
        : "";
  return `<div class="card" style="margin-top: 0.75rem;">
    ${label} — <span class="badge">${offer.status}</span>
    <p style="margin-top: 0.5rem; color: var(--muted);">Ofrece</p>
    ${renderOfferItems(offer.items, "from")}
    <p style="margin-top: 0.5rem; color: var(--muted);">Pide</p>
    ${renderOfferItems(offer.items, "to")}
    <div style="margin-top: 0.5rem;">${actions}</div>
  </div>`;
}

async function loadOffers(): Promise<void> {
  const { sent, received } = await listOffers();
  const container = document.getElementById("offers-list")!;
  container.innerHTML =
    "<h3>Recibidas</h3>" +
    received.map((o) => renderOffer(o, "received")).join("") +
    "<h3 style='margin-top: 1rem;'>Enviadas</h3>" +
    sent.map((o) => renderOffer(o, "sent")).join("");

  container.querySelectorAll<HTMLButtonElement>(".accept-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await acceptOffer(Number(btn.dataset.id));
      await loadOffers();
    })
  );
  container.querySelectorAll<HTMLButtonElement>(".decline-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await declineOffer(Number(btn.dataset.id));
      await loadOffers();
    })
  );
  container.querySelectorAll<HTMLButtonElement>(".cancel-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await cancelOffer(Number(btn.dataset.id));
      await loadOffers();
    })
  );
}

document.getElementById("search-btn")!.addEventListener("click", searchUser);
document.getElementById("send-offer-btn")!.addEventListener("click", sendOffer);
loadOffers();
