import {
  getCollection,
  listMarketplaceDemands,
  listMyMarketplaceDemands,
  createMarketplaceDemand,
  cancelMarketplaceDemand,
  type CardView,
  type MarketplaceDemandSummary,
  type MyMarketplaceDemand,
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
// rather than threaded through as parameters, matching collection.ts's pattern.
let femaleVariantBaseNames = new Set<string>();
let formLabels = new Map<string, string>();

export function renderMarketplaceCard(
  item: { cardId: string; name: string; rarity: CardView["rarity"]; imagePath: string },
  badgeHtml: string,
  quantity = 1,
  femaleVariantBaseNamesOverride?: Set<string>,
  formLabelsOverride?: Map<string, string>
): string {
  const displayCard: CardView = {
    id: item.cardId,
    name: item.name,
    rarity: item.rarity,
    imagePath: item.imagePath,
    quantity,
    generation: 0,
  };
  return renderCardHtml(
    displayCard,
    "",
    femaleVariantBaseNamesOverride ?? femaleVariantBaseNames,
    formLabelsOverride ?? formLabels,
    false,
    badgeHtml
  );
}

export function renderPublicDemandCard(offer: MarketplaceDemandSummary): string {
  const canRespond = offer.demand.viewerQuantity > 0;
  return `
    <div class="mp-offer-card" data-offer-id="${offer.id}">
      <div class="mp-offer-card-header">
        <span>Demanda de ${offer.creatorUsername}</span>
        <span>${formatDate(offer.createdAt)}</span>
      </div>
      <div class="mp-offer-card-body">
        <div>
          <p class="mp-label">Demanda</p>
          <div class="mp-grid">
            ${renderMarketplaceCard(offer.demand, `<span class="mp-have">Tienes ${offer.demand.viewerQuantity}</span>`, offer.demand.viewerQuantity)}
          </div>
        </div>
      </div>
      <button type="button" class="btn mp-respond-btn" data-id="${offer.id}" ${canRespond ? "" : 'disabled title="No tienes este cromo"'}>Responder</button>
    </div>
  `;
}

export function renderMyDemandCard(offer: MyMarketplaceDemand): string {
  return `
    <div class="mp-offer-card" data-offer-id="${offer.id}">
      <div class="mp-offer-card-header">
        <span>Activa</span>
        <span>${formatDate(offer.createdAt)}</span>
      </div>
      <div class="mp-offer-card-body">
        <div>
          <p class="mp-label">Demanda</p>
          <div class="mp-grid">
            ${renderMarketplaceCard(offer.demand, "")}
          </div>
        </div>
      </div>
      <button type="button" class="btn mp-cancel-btn" data-id="${offer.id}">Cancelar</button>
    </div>
  `;
}

let allCards: CardView[] = [];
let currentPage = 1;
let demandFilter = "";

async function loadPublicView(): Promise<void> {
  const { offers, totalCount, pageSize } = await listMarketplaceDemands({ page: currentPage, demandQuery: demandFilter });
  document.getElementById("mp-public-grid")!.innerHTML = offers.map(renderPublicDemandCard).join("");
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  document.getElementById("mp-page-label")!.textContent = `Página ${currentPage} de ${totalPages}`;
  (document.getElementById("mp-prev-page") as HTMLButtonElement).disabled = currentPage <= 1;
  (document.getElementById("mp-next-page") as HTMLButtonElement).disabled = currentPage >= totalPages;
}

// Mirrors backend's MAX_DEMANDS_PER_USER (worker/routes/marketplace.ts).
const MAX_DEMANDS_PER_USER = 4;

async function loadMineView(): Promise<void> {
  const { offers } = await listMyMarketplaceDemands();
  document.getElementById("mp-mine-grid")!.innerHTML = offers.map(renderMyDemandCard).join("");
  const createBtn = document.getElementById("mp-create-btn") as HTMLButtonElement;
  createBtn.disabled = offers.length >= MAX_DEMANDS_PER_USER;
  createBtn.title = createBtn.disabled ? "Tienes el máximo de demandas, elimina alguna antes de crear otra" : "";
}

function showTab(tab: "public" | "mine"): void {
  document.getElementById("mp-public-view")!.hidden = tab !== "public";
  document.getElementById("mp-mine-view")!.hidden = tab !== "mine";
  document.getElementById("mp-tab-mine")!.hidden = tab === "mine";
  document.getElementById("mp-tab-public")!.hidden = tab === "public";
  if (tab === "public") loadPublicView();
  else loadMineView();
}

function wireStaticEvents(): void {
  document.getElementById("mp-tab-public")!.addEventListener("click", () => showTab("public"));
  document.getElementById("mp-tab-mine")!.addEventListener("click", () => showTab("mine"));
  document.getElementById("mp-demand-filter")!.addEventListener("input", (e) => {
    demandFilter = (e.target as HTMLInputElement).value;
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
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mp-respond-btn");
    if (!btn || btn.disabled) return;
    window.location.href = `/trade.html?demandId=${btn.dataset.id}`;
  });
  document.getElementById("mp-mine-grid")!.addEventListener("click", async (e) => {
    const cancelBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mp-cancel-btn");
    if (!cancelBtn) return;
    const mineError = document.getElementById("mp-mine-error")!;
    try {
      await cancelMarketplaceDemand(Number(cancelBtn.dataset.id));
      mineError.hidden = true;
    } catch (err) {
      mineError.textContent = err instanceof Error ? err.message : "Error al cancelar la demanda";
      mineError.hidden = false;
    } finally {
      loadMineView();
    }
  });
  document.getElementById("mp-create-btn")!.addEventListener("click", openCreateDemandModal);
}

export function renderWizardPickCard(
  card: CardView,
  femaleVariantBaseNamesOverride?: Set<string>,
  formLabelsOverride?: Map<string, string>
): string {
  return renderCardHtml(
    { ...card, quantity: 1 },
    "",
    femaleVariantBaseNamesOverride ?? femaleVariantBaseNames,
    formLabelsOverride ?? formLabels,
    false
  );
}

let wizardDemand: CardView | null = null;

function openCreateDemandModal(): void {
  wizardDemand = null;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal mp-wizard">
      <input class="input" id="mp-demand-search" placeholder="Buscar Pokémon..." />
      <div id="mp-demand-results" class="mp-wizard-grid"></div>
      <p class="mp-wizard-error" id="mp-wizard-error" hidden></p>
      <div class="mp-wizard-actions">
        <button type="button" class="btn modal-cancel-btn" id="mp-wizard-close">Cancelar</button>
        <button type="button" class="btn" id="mp-wizard-submit" disabled>Crear demanda</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const demandSearch = overlay.querySelector<HTMLInputElement>("#mp-demand-search")!;
  const demandResults = overlay.querySelector<HTMLElement>("#mp-demand-results")!;
  const submitBtn = overlay.querySelector<HTMLButtonElement>("#mp-wizard-submit")!;
  const errorEl = overlay.querySelector<HTMLElement>("#mp-wizard-error")!;

  function renderDemandResults(): void {
    const query = demandSearch.value.trim();
    const filtered = query ? filterCardsByName(allCards, query).slice(0, 30) : [];
    demandResults.innerHTML = filtered
      .map(
        (c) =>
          `<div class="mp-pick-btn${wizardDemand?.id === c.id ? " selected" : ""}" role="button" tabindex="0" data-card-id="${c.id}">${renderCardHtml(c, "", femaleVariantBaseNames, formLabels)}</div>`
      )
      .join("");
    submitBtn.disabled = wizardDemand === null;
  }

  function pickDemand(cardId: string): void {
    wizardDemand = allCards.find((c) => c.id === cardId) ?? null;
    renderDemandResults();
  }

  demandSearch.addEventListener("input", renderDemandResults);
  demandResults.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".info-btn")) return;
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

  submitBtn.addEventListener("click", async () => {
    errorEl.hidden = true;
    try {
      await createMarketplaceDemand({ demandCardId: wizardDemand!.id });
      overlay.remove();
      loadMineView();
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : "Error al crear la demanda";
      errorEl.hidden = false;
    }
  });

  overlay.querySelector("#mp-wizard-close")!.addEventListener("click", () => overlay.remove());

  renderDemandResults();
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
