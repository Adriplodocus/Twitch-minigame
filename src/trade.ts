import {
  getCollection,
  getUserCollection,
  listOffers,
  createOffer,
  acceptOffer,
  declineOffer,
  cancelOffer,
  type CardView,
} from "./api";

let currentTargetUsername = "";

function renderSelectableCard(card: CardView, inputClass: string): string {
  if (card.quantity === 0) return "";
  return `
    <div class="card card-in">
      <img src="${card.imagePath}" alt="${card.name}" />
      <p style="color: var(--text-em);">${card.name} (tienes ${card.quantity})</p>
      <span class="badge rarity-${card.rarity}">${card.rarity}</span>
      <input
        type="number"
        class="input ${inputClass}"
        data-card-id="${card.id}"
        min="0"
        max="${card.quantity}"
        value="0"
        style="margin-top: 0.5rem; width: 100%;"
      />
    </div>
  `;
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

  document.getElementById("my-cards")!.innerHTML = myCollection.cards
    .map((card) => renderSelectableCard(card, "offer-qty"))
    .join("");
  document.getElementById("target-collection")!.innerHTML = targetCollection.cards
    .map((card) => renderSelectableCard(card, "request-qty"))
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

function renderOffer(offer: { id: number; status: string; toUser?: string; fromUser?: string }, kind: "sent" | "received"): string {
  const label = kind === "sent" ? `Para: ${offer.toUser}` : `De: ${offer.fromUser}`;
  const actions =
    kind === "received" && offer.status === "pending"
      ? `<button class="btn accept-btn" data-id="${offer.id}">Aceptar</button>
         <button class="btn decline-btn" data-id="${offer.id}">Rechazar</button>`
      : kind === "sent" && offer.status === "pending"
        ? `<button class="btn cancel-btn" data-id="${offer.id}">Cancelar</button>`
        : "";
  return `<div class="card" style="margin-top: 0.75rem;">${label} — <span class="badge">${offer.status}</span><div style="margin-top: 0.5rem;">${actions}</div></div>`;
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
