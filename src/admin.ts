import { GENERATIONS } from "./generations";
import { sourceLabel } from "./pack-source-label";
import { showPackReveal } from "./pack-reveal";
import type { CardView } from "./api";

interface AdminUser {
  twitchId: string;
  username: string;
  avatarUrl: string | null;
}

interface HistoryRow {
  id: number;
  userId: string;
  username: string;
  tier: string;
  source: string;
  grantedBy: string | null;
  createdAt: string;
  openedAt: string | null;
}

interface PackGrantConfig {
  rewardQuantity: number;
  bitsThreshold: number;
  bitsQuantity: number;
  subQuantity: number;
  giftSubMultiplier: number;
  paypalThreshold: number;
  paypalQuantity: number;
}

interface PaypalDonation {
  txnId: string;
  amount: number;
  currency: string;
  noteRaw: string | null;
  createdAt: string;
}

const BASE = "/api/admin";

type RequestResult<T> = { ok: true; data: T } | { ok: false; status: number; error?: string };

async function request<T>(path: string, init?: RequestInit): Promise<RequestResult<T>> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, status: res.status, error: body?.error };
  }
  return { ok: true, data: (await res.json()) as T };
}

let selectedUser: AdminUser | null = null;
let searchDebounce: ReturnType<typeof setTimeout> | undefined;

function showLoginView(): void {
  document.getElementById("login-view")!.style.display = "block";
  document.getElementById("panel-view")!.style.display = "none";
}

function showPanelView(): void {
  document.getElementById("login-view")!.style.display = "none";
  document.getElementById("panel-view")!.style.display = "block";
}

function renderHistory(history: HistoryRow[]): void {
  const container = document.getElementById("history-body")!;
  const rows = history.map((h) => {
    const tr = document.createElement("tr");
    const tdUsername = document.createElement("td");
    tdUsername.style.padding = "0.4rem";
    tdUsername.textContent = h.source === "admin" ? `${h.grantedBy ?? "Admin"} -> ${h.username}` : h.username;
    const tdTier = document.createElement("td");
    tdTier.style.padding = "0.4rem";
    tdTier.textContent = h.tier;
    const tdSource = document.createElement("td");
    tdSource.style.padding = "0.4rem";
    tdSource.textContent = sourceLabel(h.source);
    const tdCreatedAt = document.createElement("td");
    tdCreatedAt.style.padding = "0.4rem";
    tdCreatedAt.textContent = h.createdAt;
    const tdActions = document.createElement("td");
    tdActions.style.padding = "0.4rem";
    if (h.openedAt === null) {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn";
      deleteBtn.textContent = "Eliminar";
      deleteBtn.addEventListener("click", () => deletePack(h.id, h.username));
      tdActions.appendChild(deleteBtn);
    }
    tr.appendChild(tdUsername);
    tr.appendChild(tdTier);
    tr.appendChild(tdSource);
    tr.appendChild(tdCreatedAt);
    tr.appendChild(tdActions);
    return tr;
  });
  container.replaceChildren(...rows);
}

async function deletePack(packId: number, username: string): Promise<void> {
  const confirmed = await showConfirmModal(`¿Eliminar el sobre sin abrir de ${username}?`);
  if (!confirmed) return;

  const result = await request<{ ok: true }>(`/packs/${packId}`, { method: "DELETE" });
  if (!result.ok) {
    if (result.status === 401) {
      showLoginView();
      return;
    }
    return;
  }
  await loadHistory();
}

function renderSearchResults(users: AdminUser[], query: string): void {
  const container = document.getElementById("search-results")!;
  if (users.length === 0) {
    if (!query) {
      container.replaceChildren();
      return;
    }
    const lookupSpan = document.createElement("span");
    lookupSpan.className = "badge";
    lookupSpan.style.cssText = "cursor: pointer; margin: 0.2rem;";
    lookupSpan.textContent = `Dar sobres a "${query}" (buscar en Twitch)`;
    lookupSpan.addEventListener("click", () => lookupTwitchUser(query));
    container.replaceChildren(lookupSpan);
    return;
  }
  const spans = users.map((u) => {
    const span = document.createElement("span");
    span.className = "badge";
    span.dataset.twitchId = u.twitchId;
    span.style.cssText = "cursor: pointer; margin: 0.2rem;";
    span.textContent = u.username;
    span.addEventListener("click", () => {
      const user = users.find((u) => u.twitchId === span.dataset.twitchId)!;
      selectUser(user);
    });
    return span;
  });
  container.replaceChildren(...spans);
}

async function lookupTwitchUser(username: string): Promise<void> {
  const result = await request<{ user: AdminUser }>("/lookup-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!result.ok) {
    if (result.status === 401) {
      showLoginView();
      return;
    }
    document.getElementById("search-results")!.innerHTML =
      "<p>No existe ningún usuario de Twitch con ese nombre.</p>";
    return;
  }
  selectUser(result.data.user);
}

function selectUser(user: AdminUser): void {
  selectedUser = user;
  document.getElementById("selected-user")!.style.display = "flex";
  document.getElementById("selected-user-name")!.textContent = user.username;
  document.getElementById("search-results")!.innerHTML = "";
  (document.getElementById("search-input") as HTMLInputElement).value = "";
  (document.getElementById("grant-btn") as HTMLButtonElement).disabled = false;
}

function clearSelection(): void {
  selectedUser = null;
  document.getElementById("selected-user")!.style.display = "none";
  (document.getElementById("grant-btn") as HTMLButtonElement).disabled = true;
}

async function runSearch(query: string): Promise<void> {
  if (!query) {
    renderSearchResults([], "");
    return;
  }
  const result = await request<{ users: AdminUser[] }>(`/users?q=${encodeURIComponent(query)}`);
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  renderSearchResults(result.data.users, query);
}

function showConfirmModal(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position: fixed; inset: 0; background: rgba(59,46,34,0.80); display: flex; align-items: center; justify-content: center; z-index: 10; padding: 1rem;";
    const box = document.createElement("div");
    box.className = "card";
    box.style.cssText = "max-width: 320px; text-align: center;";
    const p = document.createElement("p");
    p.style.marginBottom = "1rem";
    p.textContent = message;
    box.appendChild(p);

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn";
    confirmBtn.textContent = "Confirmar";
    confirmBtn.style.marginRight = "0.5rem";
    confirmBtn.addEventListener("click", () => {
      overlay.remove();
      resolve(true);
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancelar";
    cancelBtn.addEventListener("click", () => {
      overlay.remove();
      resolve(false);
    });

    box.appendChild(confirmBtn);
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

async function loadHistory(): Promise<void> {
  const result = await request<{ history: HistoryRow[] }>("/history");
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  renderHistory(result.data.history);
}

async function performGrant(twitchId: string, quantity: number, tier: string, username: string): Promise<boolean> {
  const messageEl = document.getElementById("grant-message")!;

  const confirmed = await showConfirmModal(`¿Dar ${quantity} blíster(s) a ${username}?`);
  if (!confirmed) return false;

  const result = await request<{ ok: true }>("/grant-packs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ twitchId, quantity, tier }),
  });

  if (!result.ok) {
    if (result.status === 401) {
      showLoginView();
      return false;
    }
    messageEl.textContent = "Error al dar blíster(s).";
    return false;
  }

  messageEl.textContent = `Blíster(s) entregado(s) a ${username}.`;
  await loadHistory();
  return true;
}

async function grantPacks(): Promise<void> {
  if (!selectedUser) return;
  const quantity = Number((document.getElementById("quantity-input") as HTMLInputElement).value);
  const tier = (document.getElementById("tier-select") as HTMLSelectElement).value;
  const succeeded = await performGrant(selectedUser.twitchId, quantity, tier, selectedUser.username);
  if (succeeded) clearSelection();
}

function populateTestPackGenerations(): void {
  const select = document.getElementById("test-pack-generation") as HTMLSelectElement;
  select.replaceChildren(
    ...GENERATIONS.map((g) => {
      const option = document.createElement("option");
      option.value = String(g.id);
      option.textContent = `Gen ${g.id} · ${g.region}`;
      return option;
    })
  );
}

function readTestPackCounts(): { common: number; rare: number; epic: number; legendary: number; shiny: number } {
  const value = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value) || 0;
  return {
    common: value("tp-common"),
    rare: value("tp-rare"),
    epic: value("tp-epic"),
    legendary: value("tp-legendary"),
    shiny: value("tp-shiny"),
  };
}

async function openTestPack(): Promise<void> {
  const messageEl = document.getElementById("test-pack-message")!;
  const generation = Number((document.getElementById("test-pack-generation") as HTMLSelectElement).value);
  const tier = (document.getElementById("test-pack-tier") as HTMLSelectElement).value;
  const counts = readTestPackCounts();
  const forcingCounts = Object.values(counts).some((n) => n > 0);

  const result = await request<{ packId: number; cards: CardView[] }>("/test-pack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(forcingCounts ? { generation, tier, counts } : { generation, tier }),
  });

  if (!result.ok) {
    if (result.status === 401) {
      showLoginView();
      return;
    }
    messageEl.textContent = result.error ?? "Error al abrir el sobre de prueba.";
    return;
  }

  messageEl.textContent = "";
  const { packId, cards } = result.data;
  await showPackReveal(cards, async () => {
    const broadcastResult = await request(`/test-pack/${packId}/broadcast`, { method: "POST" });
    if (!broadcastResult.ok) throw new Error("broadcast failed");
  });
}

function renderPaypalDonations(donations: PaypalDonation[]): void {
  const container = document.getElementById("paypal-donations-list")!;
  if (donations.length === 0) {
    container.innerHTML = "<p>Sin donaciones pendientes.</p>";
    return;
  }
  const rows = donations.map((d) => {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap;";

    const info = document.createElement("span");
    info.textContent = `${d.amount} ${d.currency} · nota: "${d.noteRaw ?? "(vacía)"}" · ${d.createdAt}`;

    const usernameInput = document.createElement("input");
    usernameInput.className = "input";
    usernameInput.placeholder = "Twitch username";
    usernameInput.style.width = "160px";

    const quantityInput = document.createElement("input");
    quantityInput.className = "input";
    quantityInput.type = "number";
    quantityInput.min = "1";
    quantityInput.max = "50";
    quantityInput.value = "1";
    quantityInput.style.width = "70px";

    const resolveBtn = document.createElement("button");
    resolveBtn.className = "btn";
    resolveBtn.textContent = "Asignar";
    resolveBtn.addEventListener("click", () => resolveDonation(d.txnId, usernameInput, quantityInput, row));

    row.append(info, usernameInput, quantityInput, resolveBtn);
    return row;
  });
  container.replaceChildren(...rows);
}

async function resolveDonation(
  txnId: string,
  usernameInput: HTMLInputElement,
  quantityInput: HTMLInputElement,
  row: HTMLElement
): Promise<void> {
  const username = usernameInput.value.trim();
  if (!username) return;

  const lookup = await request<{ user: AdminUser }>("/lookup-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!lookup.ok) {
    if (lookup.status === 401) showLoginView();
    return;
  }

  const quantity = Number(quantityInput.value);
  const result = await request<{ ok: true }>(`/paypal-donations/${txnId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ twitchId: lookup.data.user.twitchId, quantity }),
  });
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  row.remove();
}

async function loadPaypalDonations(): Promise<void> {
  const result = await request<{ donations: PaypalDonation[] }>("/paypal-donations?status=unmatched");
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  renderPaypalDonations(result.data.donations);
}

async function loadPackGrantConfig(): Promise<void> {
  const result = await request<{ config: PackGrantConfig }>("/pack-grant-config");
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  const { config } = result.data;
  (document.getElementById("cfg-reward-quantity") as HTMLInputElement).value = String(config.rewardQuantity);
  (document.getElementById("cfg-bits-threshold") as HTMLInputElement).value = String(config.bitsThreshold);
  (document.getElementById("cfg-bits-quantity") as HTMLInputElement).value = String(config.bitsQuantity);
  (document.getElementById("cfg-sub-quantity") as HTMLInputElement).value = String(config.subQuantity);
  (document.getElementById("cfg-gift-sub-multiplier") as HTMLInputElement).value = String(config.giftSubMultiplier);
  (document.getElementById("cfg-paypal-threshold") as HTMLInputElement).value = String(config.paypalThreshold);
  (document.getElementById("cfg-paypal-quantity") as HTMLInputElement).value = String(config.paypalQuantity);
}

async function savePackGrantConfig(): Promise<void> {
  const messageEl = document.getElementById("cfg-message")!;
  const config: PackGrantConfig = {
    rewardQuantity: Number((document.getElementById("cfg-reward-quantity") as HTMLInputElement).value),
    bitsThreshold: Number((document.getElementById("cfg-bits-threshold") as HTMLInputElement).value),
    bitsQuantity: Number((document.getElementById("cfg-bits-quantity") as HTMLInputElement).value),
    subQuantity: Number((document.getElementById("cfg-sub-quantity") as HTMLInputElement).value),
    giftSubMultiplier: Number((document.getElementById("cfg-gift-sub-multiplier") as HTMLInputElement).value),
    paypalThreshold: Number((document.getElementById("cfg-paypal-threshold") as HTMLInputElement).value),
    paypalQuantity: Number((document.getElementById("cfg-paypal-quantity") as HTMLInputElement).value),
  };

  const result = await request<{ ok: true }>("/pack-grant-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });

  if (!result.ok) {
    if (result.status === 401) {
      showLoginView();
      return;
    }
    messageEl.textContent = "Error al guardar la configuración.";
    return;
  }

  messageEl.textContent = "Configuración guardada.";
}

async function login(): Promise<void> {
  const name = (document.getElementById("login-name") as HTMLInputElement).value;
  const password = (document.getElementById("login-password") as HTMLInputElement).value;
  const errorEl = document.getElementById("login-error")!;

  const result = await request<{ ok: true }>("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, name }),
  });

  if (!result.ok) {
    errorEl.textContent = result.status === 400 ? "Falta el nombre." : "Clave incorrecta.";
    errorEl.style.display = "block";
    return;
  }

  errorEl.style.display = "none";
  showPanelView();
  await loadHistory();
  await loadPackGrantConfig();
  await loadPaypalDonations();
}

async function logout(): Promise<void> {
  await request("/logout", { method: "POST" });
  showLoginView();
}

document.getElementById("login-btn")!.addEventListener("click", login);
document.getElementById("logout-btn")!.addEventListener("click", logout);
document.getElementById("clear-selection-btn")!.addEventListener("click", clearSelection);
document.getElementById("grant-btn")!.addEventListener("click", grantPacks);
document.getElementById("test-pack-btn")!.addEventListener("click", openTestPack);
document.getElementById("cfg-save-btn")!.addEventListener("click", savePackGrantConfig);
populateTestPackGenerations();
document.getElementById("search-input")!.addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  const query = (e.target as HTMLInputElement).value;
  searchDebounce = setTimeout(() => runSearch(query), 250);
});
async function init(): Promise<void> {
  const result = await request<{ history: HistoryRow[] }>("/history");
  if (result.ok) {
    showPanelView();
    renderHistory(result.data.history);
    await loadPackGrantConfig();
    await loadPaypalDonations();
  } else {
    showLoginView();
  }
}

init();
