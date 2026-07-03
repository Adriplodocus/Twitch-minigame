import {
  listOffers,
  acceptOffer,
  declineOffer,
  cancelOffer,
  logout,
  type TradeOfferItem,
  type TradeOfferSummary,
} from "./api";
import { renderCardHtml } from "./card";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  accepted: "Aceptada",
  declined: "Rechazada",
  cancelled: "Cancelada",
};

function renderOfferItems(items: TradeOfferItem[], side: "from" | "to"): string {
  const filtered = items.filter((item) => item.side === side);
  if (filtered.length === 0) return `<p class="offer-card-empty">— nada —</p>`;
  return `<div class="offer-card-items">${filtered
    .map((item) => renderCardHtml({ id: item.cardId, name: item.name, rarity: item.rarity, imagePath: item.imagePath, quantity: item.quantity }))
    .join("")}</div>`;
}

function renderOffer(offer: TradeOfferSummary, kind: "sent" | "received"): string {
  const username = kind === "received" ? offer.fromUser : offer.toUser;
  const leftLabel = kind === "received" ? "Te ofrece" : "Tú le pides";
  const rightLabel = kind === "received" ? "Te pide" : "Tú le ofreces";
  const leftSide = kind === "received" ? "from" : "to";
  const rightSide = kind === "received" ? "to" : "from";
  const actions =
    kind === "received" && offer.status === "pending"
      ? `<button class="btn accept-btn" data-id="${offer.id}">Aceptar</button>
         <button class="btn decline-btn" data-id="${offer.id}">Rechazar</button>`
      : kind === "sent" && offer.status === "pending"
        ? `<button class="btn cancel-btn" data-id="${offer.id}">Cancelar</button>`
        : "";
  const statusLabel = STATUS_LABELS[offer.status] ?? offer.status;

  return `<div class="offer-card">
    <div class="offer-card-header">
      <span class="offer-card-user">${username}</span>
      <span class="badge offer-status offer-status-${offer.status}">${statusLabel}</span>
    </div>
    <div class="offer-card-body">
      <div class="offer-card-side">
        <p class="offer-card-side-label">${leftLabel}</p>
        ${renderOfferItems(offer.items, leftSide)}
      </div>
      <div class="offer-card-side">
        <p class="offer-card-side-label">${rightLabel}</p>
        ${renderOfferItems(offer.items, rightSide)}
      </div>
    </div>
    ${actions ? `<div class="offer-card-actions">${actions}</div>` : ""}
  </div>`;
}

async function loadOffers(): Promise<void> {
  const { sent, received } = await listOffers();
  const container = document.getElementById("offers-list")!;
  container.innerHTML = `
    <div class="offers-column">
      <h2 class="section-heading">Recibidas</h2>
      ${received.length ? received.map((o) => renderOffer(o, "received")).join("") : `<p class="offers-column-empty">— sin ofertas recibidas —</p>`}
    </div>
    <div class="offers-column">
      <h2 class="section-heading">Enviadas</h2>
      ${sent.length ? sent.map((o) => renderOffer(o, "sent")).join("") : `<p class="offers-column-empty">— sin ofertas enviadas —</p>`}
    </div>
  `;

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

document.getElementById("logout-btn")!.addEventListener("click", async () => {
  await logout();
  window.location.href = "/";
});

loadOffers();
