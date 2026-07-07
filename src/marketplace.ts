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
  // quantity: 1 above keeps foil/shiny/tiltable VFX active (these cards
  // represent trade items, not the viewer's "unowned" state) — but that
  // also makes renderCardHtml's own quantity>0 auto-badge fire. Suppress
  // just that badge via showQtyBadge so only the caller-supplied
  // badgeHtml (e.g. "Tienes N") is shown, avoiding a duplicate/contradictory "x1".
  return renderCardHtml(displayCard, badgeHtml, undefined, undefined, false);
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
  document.getElementById("mp-create-btn")!.addEventListener("click", openCreateWizard);
}

let wizardDemand: CardView | null = null;
const wizardOfferQuantities = new Map<string, number>();

function openCreateWizard(): void {
  let step = 1;
  wizardDemand = null;
  wizardOfferQuantities.clear();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal mp-wizard">
      <div class="mp-wizard-progress">
        <span class="mp-wizard-step active" data-step="1">1. Demanda</span>
        <span class="mp-wizard-step" data-step="2">2. Oferta</span>
        <span class="mp-wizard-step" data-step="3">3. Confirmación</span>
      </div>
      <div class="mp-wizard-panel" data-panel="1">
        <input class="input" id="mp-demand-search" placeholder="Buscar Pokémon..." />
        <div id="mp-demand-results" class="mp-grid"></div>
      </div>
      <div class="mp-wizard-panel" data-panel="2" hidden>
        <div class="mp-wizard-offer-columns">
          <div>
            <input class="input" id="mp-offer-search" placeholder="Buscar en tu colección..." />
            <div id="mp-offer-results" class="mp-grid"></div>
          </div>
          <div>
            <p class="mp-label">Ofreces</p>
            <div id="mp-offer-preview" class="mp-grid"></div>
          </div>
        </div>
      </div>
      <div class="mp-wizard-panel" data-panel="3" hidden>
        <div class="mp-offer-card-preview">
          <div>
            <p class="mp-label">Demanda</p>
            <div id="mp-confirm-demand" class="mp-grid"></div>
          </div>
          <div>
            <p class="mp-label">Ofrece</p>
            <div id="mp-confirm-offer" class="mp-grid"></div>
          </div>
        </div>
      </div>
      <p class="mp-wizard-error" id="mp-wizard-error" hidden></p>
      <div class="mp-wizard-actions">
        <button type="button" class="btn modal-cancel-btn" id="mp-wizard-close">Cancelar</button>
        <button type="button" class="btn" id="mp-wizard-back" hidden>Atrás</button>
        <button type="button" class="btn" id="mp-wizard-next" disabled>Siguiente</button>
        <button type="button" class="btn" id="mp-wizard-submit" hidden>Crear oferta</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const demandSearch = overlay.querySelector<HTMLInputElement>("#mp-demand-search")!;
  const demandResults = overlay.querySelector<HTMLElement>("#mp-demand-results")!;
  const offerSearch = overlay.querySelector<HTMLInputElement>("#mp-offer-search")!;
  const offerResults = overlay.querySelector<HTMLElement>("#mp-offer-results")!;
  const offerPreview = overlay.querySelector<HTMLElement>("#mp-offer-preview")!;
  const confirmDemand = overlay.querySelector<HTMLElement>("#mp-confirm-demand")!;
  const confirmOffer = overlay.querySelector<HTMLElement>("#mp-confirm-offer")!;
  const nextBtn = overlay.querySelector<HTMLButtonElement>("#mp-wizard-next")!;
  const backBtn = overlay.querySelector<HTMLButtonElement>("#mp-wizard-back")!;
  const submitBtn = overlay.querySelector<HTMLButtonElement>("#mp-wizard-submit")!;
  const errorEl = overlay.querySelector<HTMLElement>("#mp-wizard-error")!;

  function renderDemandResults(): void {
    const filtered = filterCardsByName(allCards, demandSearch.value).slice(0, 30);
    demandResults.innerHTML = filtered
      .map(
        (c) =>
          `<button type="button" class="mp-pick-btn${wizardDemand?.id === c.id ? " selected" : ""}" data-card-id="${c.id}">${renderCardHtml({ ...c, quantity: 1 })}</button>`
      )
      .join("");
    nextBtn.disabled = wizardDemand === null;
  }

  function offerPreviewHtml(): string {
    return Array.from(wizardOfferQuantities, ([cardId, quantity]) => {
      const card = allCards.find((c) => c.id === cardId)!;
      return renderCardHtml({ ...card, quantity });
    }).join("");
  }

  function renderOfferResults(): void {
    const filtered = filterCardsByName(allCards, offerSearch.value).filter((c) => c.quantity > 0);
    offerResults.innerHTML = filtered
      .map((c) => {
        const value = wizardOfferQuantities.get(c.id) ?? 0;
        const input = `<input type="number" class="input mp-offer-qty-input" data-card-id="${c.id}" min="0" max="${c.quantity}" value="${value}" style="margin-top:0.5rem;width:100%;" />`;
        return renderCardHtml(c, input);
      })
      .join("");
    offerPreview.innerHTML = offerPreviewHtml();
  }

  demandSearch.addEventListener("input", renderDemandResults);
  demandResults.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".mp-pick-btn");
    if (!btn) return;
    wizardDemand = allCards.find((c) => c.id === btn.dataset.cardId) ?? null;
    renderDemandResults();
  });

  offerSearch.addEventListener("input", renderOfferResults);
  offerResults.addEventListener("input", (e) => {
    const input = e.target as HTMLElement;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains("mp-offer-qty-input")) return;
    const cardId = input.dataset.cardId!;
    const value = Number(input.value);
    if (value > 0) wizardOfferQuantities.set(cardId, value);
    else wizardOfferQuantities.delete(cardId);
    offerPreview.innerHTML = offerPreviewHtml();
    nextBtn.disabled = wizardOfferQuantities.size === 0;
  });

  function showStep(n: number): void {
    step = n;
    overlay.querySelectorAll<HTMLElement>(".mp-wizard-step").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.step) === n);
    });
    overlay.querySelectorAll<HTMLElement>(".mp-wizard-panel").forEach((el) => {
      el.hidden = Number(el.dataset.panel) !== n;
    });
    backBtn.hidden = n === 1;
    nextBtn.hidden = n === 3;
    submitBtn.hidden = n !== 3;
    if (n === 1) nextBtn.disabled = wizardDemand === null;
    if (n === 2) {
      renderOfferResults();
      nextBtn.disabled = wizardOfferQuantities.size === 0;
    }
    if (n === 3) {
      confirmDemand.innerHTML = renderCardHtml({ ...wizardDemand!, quantity: 1 });
      confirmOffer.innerHTML = offerPreviewHtml();
    }
  }

  nextBtn.addEventListener("click", () => showStep(step + 1));
  backBtn.addEventListener("click", () => showStep(step - 1));

  submitBtn.addEventListener("click", async () => {
    errorEl.hidden = true;
    try {
      await createMarketplaceOffer({
        demandCardId: wizardDemand!.id,
        offerItems: Array.from(wizardOfferQuantities, ([cardId, quantity]) => ({ cardId, quantity })),
      });
      overlay.remove();
      loadMineView();
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : "Error al crear la oferta";
      errorEl.hidden = false;
    }
  });

  overlay.querySelector("#mp-wizard-close")!.addEventListener("click", () => overlay.remove());

  renderDemandResults();
  showStep(1);
}

async function init(): Promise<void> {
  initUserHeader();
  wireStaticEvents();
  const collection = await getCollection();
  allCards = collection.cards;
  const params = new URLSearchParams(window.location.search);
  showTab(params.get("tab") === "mine" ? "mine" : "public");
}

if (typeof document !== "undefined" && document.getElementById("mp-tab-public")) {
  init();
}
