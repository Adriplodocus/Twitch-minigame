import {
  getCollection,
  listMarketplaceOffers,
  listMyMarketplaceOffers,
  createMarketplaceOffer,
  acceptMarketplaceOffer,
  cancelMarketplaceOffer,
  deleteMarketplaceOffer,
  type CardView,
  type MarketplaceOfferSummary,
  type MyMarketplaceOffer,
} from "./api";
import { renderCardHtml, filterCardsByName } from "./card";
import { initUserHeader } from "./user-header";

export function formatDate(sqliteTimestamp: string): string {
  const iso = sqliteTimestamp.includes("T") ? sqliteTimestamp : `${sqliteTimestamp.replace(" ", "T")}Z`;
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export function renderMarketplaceCard(
  item: { cardId: string; name: string; rarity: CardView["rarity"]; imagePath: string },
  badgeHtml: string
): string {
  const displayCard: CardView = {
    id: item.cardId,
    name: item.name,
    rarity: item.rarity,
    imagePath: item.imagePath,
    quantity: 1,
    generation: 0,
  };
  return renderCardHtml(displayCard, badgeHtml);
}

export function renderPublicOfferCard(offer: MarketplaceOfferSummary): string {
  const canAccept = offer.demand.viewerQuantity > 0;
  return `
    <div class="mp-offer-card" data-offer-id="${offer.id}">
      <div class="mp-offer-card-header">
        <span>Oferta de ${offer.creatorUsername}</span>
        <span>${formatDate(offer.createdAt)}</span>
      </div>
      <div class="mp-offer-card-body">
        <div>
          <p class="mp-label">Demanda</p>
          ${renderMarketplaceCard(offer.demand, `<span class="mp-have">Tienes ${offer.demand.viewerQuantity}</span>`)}
        </div>
        <div>
          <p class="mp-label">Ofrece</p>
          <div class="mp-grid">
            ${offer.offerItems
              .map((i) => renderMarketplaceCard(i, `<span class="mp-have">Tienes ${i.viewerQuantity}</span>`))
              .join("")}
          </div>
        </div>
      </div>
      <button type="button" class="btn mp-accept-btn" data-id="${offer.id}" ${canAccept ? "" : 'disabled title="No tienes este cromo"'}>Aceptar</button>
    </div>
  `;
}

export function renderMyOfferCard(offer: MyMarketplaceOffer): string {
  const action =
    offer.status === "active"
      ? `<button type="button" class="btn mp-cancel-btn" data-id="${offer.id}">Cancelar</button>`
      : `<button type="button" class="btn mp-delete-btn" data-id="${offer.id}">Eliminar</button>`;
  return `
    <div class="mp-offer-card" data-offer-id="${offer.id}">
      <div class="mp-offer-card-header">
        <span>${offer.status === "accepted" ? "Aceptada" : "Activa"}</span>
        <span>${formatDate(offer.createdAt)}</span>
      </div>
      <div class="mp-offer-card-body">
        <div>
          <p class="mp-label">Demanda</p>
          ${renderMarketplaceCard(offer.demand, "")}
        </div>
        <div>
          <p class="mp-label">Ofrece</p>
          <div class="mp-grid">
            ${offer.offerItems.map((i) => renderMarketplaceCard(i, `<span class="mp-qty">x${i.quantity}</span>`)).join("")}
          </div>
        </div>
      </div>
      ${action}
    </div>
  `;
}

let allCards: CardView[] = [];
let currentPage = 1;
let demandFilter = "";
let offerFilter = "";

async function loadPublicView(): Promise<void> {
  const { offers, totalCount, pageSize } = await listMarketplaceOffers({
    page: currentPage,
    demandQuery: demandFilter,
    offerQuery: offerFilter,
  });
  document.getElementById("mp-public-grid")!.innerHTML = offers.map(renderPublicOfferCard).join("");
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  document.getElementById("mp-page-label")!.textContent = `Página ${currentPage} de ${totalPages}`;
  (document.getElementById("mp-prev-page") as HTMLButtonElement).disabled = currentPage <= 1;
  (document.getElementById("mp-next-page") as HTMLButtonElement).disabled = currentPage >= totalPages;
}

async function loadMineView(): Promise<void> {
  const { offers } = await listMyMarketplaceOffers();
  document.getElementById("mp-mine-grid")!.innerHTML = offers.map(renderMyOfferCard).join("");
}

function showTab(tab: "public" | "mine"): void {
  document.getElementById("mp-public-view")!.hidden = tab !== "public";
  document.getElementById("mp-mine-view")!.hidden = tab !== "mine";
  if (tab === "public") loadPublicView();
  else loadMineView();
}

function openAcceptModal(offerId: number): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <p>¿Seguro que quieres aceptar esta oferta? El intercambio se realiza inmediatamente.</p>
      <button type="button" class="btn" id="mp-accept-confirm">Aceptar</button>
      <button type="button" class="btn modal-cancel-btn" id="mp-accept-cancel">Cancelar</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#mp-accept-cancel")!.addEventListener("click", () => overlay.remove());
  overlay.querySelector("#mp-accept-confirm")!.addEventListener("click", async () => {
    await acceptMarketplaceOffer(offerId);
    overlay.remove();
    loadPublicView();
  });
}

function wireStaticEvents(): void {
  document.getElementById("mp-tab-public")!.addEventListener("click", () => showTab("public"));
  document.getElementById("mp-tab-mine")!.addEventListener("click", () => showTab("mine"));
  document.getElementById("mp-demand-filter")!.addEventListener("input", (e) => {
    demandFilter = (e.target as HTMLInputElement).value;
    currentPage = 1;
    loadPublicView();
  });
  document.getElementById("mp-offer-filter")!.addEventListener("input", (e) => {
    offerFilter = (e.target as HTMLInputElement).value;
    currentPage = 1;
    loadPublicView();
  });
  document.getElementById("mp-prev-page")!.addEventListener("click", () => {
    currentPage--;
    loadPublicView();
  });
  document.getElementById("mp-next-page")!.addEventListener("click", () => {
    currentPage++;
    loadPublicView();
  });
  document.getElementById("mp-public-grid")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mp-accept-btn");
    if (!btn || btn.disabled) return;
    openAcceptModal(Number(btn.dataset.id));
  });
  document.getElementById("mp-mine-grid")!.addEventListener("click", async (e) => {
    const cancelBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mp-cancel-btn");
    const deleteBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mp-delete-btn");
    if (cancelBtn) {
      await cancelMarketplaceOffer(Number(cancelBtn.dataset.id));
      loadMineView();
    } else if (deleteBtn) {
      await deleteMarketplaceOffer(Number(deleteBtn.dataset.id));
      loadMineView();
    }
  });
}

async function init(): Promise<void> {
  initUserHeader();
  wireStaticEvents();
  const collection = await getCollection();
  allCards = collection.cards;
  void allCards; // consumed by the creation wizard added in Task 9
  const params = new URLSearchParams(window.location.search);
  showTab(params.get("tab") === "mine" ? "mine" : "public");
}

if (typeof document !== "undefined" && document.getElementById("mp-tab-public")) {
  init();
}
