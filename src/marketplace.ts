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
import { renderCardHtml, filterCardsByName, collectFemaleVariantBaseNames, computeFormLabels } from "./card";
import { initUserHeader } from "./user-header";

export function formatDate(sqliteTimestamp: string): string {
  const iso = sqliteTimestamp.includes("T") ? sqliteTimestamp : `${sqliteTimestamp.replace(" ", "T")}Z`;
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Populated once collection data loads (see init()); read here via closure
// rather than threaded through as parameters, matching collection.ts's
// pattern. Empty by default so direct unit tests of the render functions
// below don't need to seed them.
let femaleVariantBaseNames = new Set<string>();
let formLabels = new Map<string, string>();

export function renderMarketplaceCard(
  item: { cardId: string; name: string; rarity: CardView["rarity"]; imagePath: string },
  badgeHtml: string,
  // Optional overrides so this can be unit-tested with explicit fixtures
  // without needing init() to have populated the module-level maps below
  // (which only happens once real DOM/collection data exists).
  femaleVariantBaseNamesOverride?: Set<string>,
  formLabelsOverride?: Map<string, string>
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
  // represent trade items, not the viewer's "unowned" state). badgeHtml is
  // passed as footerBadgeHtml so it renders inside the card's own footer
  // row (alongside the info button) instead of appended below the card,
  // which used to add a full extra line of height to every card.
  // femaleVariantBaseNames/formLabels move variant words (e.g. "Mega X",
  // "Mega Y") out of the visible name into the info tooltip's "Variante"
  // line, same as every other page — without them, a name like "Mewtwo
  // Mega X" stays whole and wraps to multiple lines, breaking the grid.
  return renderCardHtml(
    displayCard,
    "",
    femaleVariantBaseNamesOverride ?? femaleVariantBaseNames,
    formLabelsOverride ?? formLabels,
    false,
    badgeHtml
  );
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
          <div class="mp-grid">
            ${renderMarketplaceCard(offer.demand, `<span class="mp-have">Tienes ${offer.demand.viewerQuantity}</span>`)}
          </div>
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
          <div class="mp-grid">
            ${renderMarketplaceCard(offer.demand, "")}
          </div>
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
      <p class="mp-wizard-error" id="mp-accept-error" hidden></p>
      <button type="button" class="btn" id="mp-accept-confirm">Aceptar</button>
      <button type="button" class="btn modal-cancel-btn" id="mp-accept-cancel">Cancelar</button>
    </div>
  `;
  document.body.appendChild(overlay);
  const errorEl = overlay.querySelector<HTMLElement>("#mp-accept-error")!;
  overlay.querySelector("#mp-accept-cancel")!.addEventListener("click", () => overlay.remove());
  overlay.querySelector("#mp-accept-confirm")!.addEventListener("click", async () => {
    errorEl.hidden = true;
    try {
      await acceptMarketplaceOffer(offerId);
      overlay.remove();
      loadPublicView();
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : "Error al aceptar la oferta";
      errorEl.hidden = false;
      loadPublicView();
    }
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
    const mineError = document.getElementById("mp-mine-error")!;
    if (cancelBtn) {
      try {
        await cancelMarketplaceOffer(Number(cancelBtn.dataset.id));
        mineError.hidden = true;
      } catch (err) {
        mineError.textContent = err instanceof Error ? err.message : "Error al cancelar la oferta";
        mineError.hidden = false;
      } finally {
        loadMineView();
      }
    } else if (deleteBtn) {
      try {
        await deleteMarketplaceOffer(Number(deleteBtn.dataset.id));
        mineError.hidden = true;
      } catch (err) {
        mineError.textContent = err instanceof Error ? err.message : "Error al eliminar la oferta";
        mineError.hidden = false;
      } finally {
        loadMineView();
      }
    }
  });
  document.getElementById("mp-create-btn")!.addEventListener("click", openCreateWizard);
}

export function renderWizardPickCard(
  card: CardView,
  femaleVariantBaseNamesOverride?: Set<string>,
  formLabelsOverride?: Map<string, string>
): string {
  // quantity: 1 keeps foil/shiny/tiltable VFX active (the wizard's demand
  // picker and step-3 confirm panel show cards as items to pick, not the
  // viewer's owned-quantity state) — but that also makes renderCardHtml's
  // own quantity>0 auto-badge fire. Suppress just that badge via
  // showQtyBadge, same fix as renderMarketplaceCard above. femaleVariantBaseNames/
  // formLabels strip variant words (e.g. "Mega X") out of the visible name,
  // same reasoning as renderMarketplaceCard; overrides exist for direct
  // unit testing, same as there.
  return renderCardHtml(
    { ...card, quantity: 1 },
    "",
    femaleVariantBaseNamesOverride ?? femaleVariantBaseNames,
    formLabelsOverride ?? formLabels,
    false
  );
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
        <div id="mp-demand-results" class="mp-wizard-grid"></div>
      </div>
      <div class="mp-wizard-panel" data-panel="2" hidden>
        <div class="mp-wizard-offer-columns">
          <div>
            <input class="input" id="mp-offer-search" placeholder="Buscar en tu colección..." />
            <div id="mp-offer-results" class="mp-wizard-grid"></div>
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
    const query = demandSearch.value.trim();
    const filtered = query ? filterCardsByName(allCards, query).slice(0, 30) : [];
    demandResults.innerHTML = filtered
      .map(
        // A <button> wrapper here would nest the card's own .info-btn <button>
        // inside it, which is invalid HTML — browsers silently reparent the
        // inner button out of the outer one, breaking both its position and
        // its click handling. Use a div with button semantics instead.
        (c) =>
          `<div class="mp-pick-btn${wizardDemand?.id === c.id ? " selected" : ""}" role="button" tabindex="0" data-card-id="${c.id}">${renderWizardPickCard(c)}</div>`
      )
      .join("");
    nextBtn.disabled = wizardDemand === null;
  }

  function offerPreviewHtml(): string {
    return Array.from(wizardOfferQuantities, ([cardId, quantity]) => {
      const card = allCards.find((c) => c.id === cardId)!;
      return renderCardHtml({ ...card, quantity }, "", femaleVariantBaseNames, formLabels);
    }).join("");
  }

  function renderOfferResults(): void {
    const query = offerSearch.value.trim();
    const filtered = query ? filterCardsByName(allCards, query).filter((c) => c.quantity > 0) : [];
    offerResults.innerHTML = filtered
      .map((c) => {
        const value = wizardOfferQuantities.get(c.id) ?? 0;
        const input = `<input type="number" class="input mp-offer-qty-input" data-card-id="${c.id}" min="0" max="${c.quantity}" value="${value}" style="margin-top:0.5rem;width:100%;" />`;
        return renderCardHtml(c, input, femaleVariantBaseNames, formLabels);
      })
      .join("");
    offerPreview.innerHTML = offerPreviewHtml();
  }

  function pickDemand(cardId: string): void {
    wizardDemand = allCards.find((c) => c.id === cardId) ?? null;
    renderDemandResults();
  }

  demandSearch.addEventListener("input", renderDemandResults);
  demandResults.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".info-btn")) return; // let the info tooltip toggle without also picking the card
    const btn = target.closest<HTMLElement>(".mp-pick-btn");
    if (!btn) return;
    pickDemand(btn.dataset.cardId!);
  });
  demandResults.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains("mp-pick-btn")) return;
    e.preventDefault();
    pickDemand(target.dataset.cardId!);
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
      confirmDemand.innerHTML = renderWizardPickCard(wizardDemand!);
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
  femaleVariantBaseNames = collectFemaleVariantBaseNames(allCards);
  formLabels = computeFormLabels(allCards);
  const params = new URLSearchParams(window.location.search);
  showTab(params.get("tab") === "mine" ? "mine" : "public");
}

if (typeof document !== "undefined" && document.getElementById("mp-tab-public")) {
  init();
}
