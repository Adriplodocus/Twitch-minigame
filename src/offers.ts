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

document.getElementById("logout-btn")!.addEventListener("click", async () => {
  await logout();
  window.location.href = "/";
});

loadOffers();
