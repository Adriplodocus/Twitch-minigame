interface AdminUser {
  twitchId: string;
  username: string;
  avatarUrl: string | null;
}

interface HistoryRow {
  id: number;
  userId: string;
  username: string;
  createdAt: string;
}

const BASE = "/api/admin";

type RequestResult<T> = { ok: true; data: T } | { ok: false; status: number };

async function request<T>(path: string, init?: RequestInit): Promise<RequestResult<T>> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: (await res.json()) as T };
}

let selectedUser: AdminUser | null = null;
let searchDebounce: ReturnType<typeof setTimeout> | undefined;
let currentUsersPage = 1;

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
    tdUsername.textContent = h.username;
    const tdCreatedAt = document.createElement("td");
    tdCreatedAt.style.padding = "0.4rem";
    tdCreatedAt.textContent = h.createdAt;
    tr.appendChild(tdUsername);
    tr.appendChild(tdCreatedAt);
    return tr;
  });
  container.replaceChildren(...rows);
}

function renderSearchResults(users: AdminUser[]): void {
  const container = document.getElementById("search-results")!;
  if (users.length === 0) {
    container.replaceChildren();
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
    renderSearchResults([]);
    return;
  }
  const result = await request<{ users: AdminUser[] }>(`/users?q=${encodeURIComponent(query)}`);
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  renderSearchResults(result.data.users);
}

function showConfirmModal(quantity: number, username: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position: fixed; inset: 0; background: rgba(59,46,34,0.80); display: flex; align-items: center; justify-content: center; z-index: 10; padding: 1rem;";
    const box = document.createElement("div");
    box.className = "card";
    box.style.cssText = "max-width: 320px; text-align: center;";
    const p = document.createElement("p");
    p.style.marginBottom = "1rem";
    p.textContent = `¿Dar ${quantity} blíster(s) a ${username}?`;
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

async function performGrant(twitchId: string, quantity: number, username: string): Promise<boolean> {
  const messageEl = document.getElementById("grant-message")!;

  const confirmed = await showConfirmModal(quantity, username);
  if (!confirmed) return false;

  const result = await request<{ ok: true }>("/grant-packs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ twitchId, quantity }),
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
  const succeeded = await performGrant(selectedUser.twitchId, quantity, selectedUser.username);
  if (succeeded) clearSelection();
}

function renderAllUsers(users: AdminUser[]): void {
  const container = document.getElementById("all-users-body")!;
  const rows = users.map((u) => {
    const tr = document.createElement("tr");

    const tdUsername = document.createElement("td");
    tdUsername.style.padding = "0.4rem";
    tdUsername.textContent = u.username;

    const tdAction = document.createElement("td");
    tdAction.style.padding = "0.4rem";
    const grantBtn = document.createElement("button");
    grantBtn.className = "btn";
    grantBtn.textContent = "+1 blíster";
    grantBtn.addEventListener("click", () => performGrant(u.twitchId, 1, u.username));
    tdAction.appendChild(grantBtn);

    tr.appendChild(tdUsername);
    tr.appendChild(tdAction);
    return tr;
  });
  container.replaceChildren(...rows);
}

async function loadAllUsers(page: number): Promise<void> {
  const result = await request<{ users: AdminUser[]; page: number; hasMore: boolean }>(`/users/all?page=${page}`);
  if (!result.ok) {
    if (result.status === 401) showLoginView();
    return;
  }
  currentUsersPage = result.data.page;
  renderAllUsers(result.data.users);
  (document.getElementById("users-prev-btn") as HTMLButtonElement).disabled = currentUsersPage <= 1;
  (document.getElementById("users-next-btn") as HTMLButtonElement).disabled = !result.data.hasMore;
}

async function login(): Promise<void> {
  const password = (document.getElementById("login-password") as HTMLInputElement).value;
  const errorEl = document.getElementById("login-error")!;

  const result = await request<{ ok: true }>("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (!result.ok) {
    errorEl.textContent = "Clave incorrecta.";
    errorEl.style.display = "block";
    return;
  }

  errorEl.style.display = "none";
  showPanelView();
  await loadHistory();
  await loadAllUsers(1);
}

async function logout(): Promise<void> {
  await request("/logout", { method: "POST" });
  showLoginView();
}

document.getElementById("login-btn")!.addEventListener("click", login);
document.getElementById("logout-btn")!.addEventListener("click", logout);
document.getElementById("clear-selection-btn")!.addEventListener("click", clearSelection);
document.getElementById("grant-btn")!.addEventListener("click", grantPacks);
document.getElementById("search-input")!.addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  const query = (e.target as HTMLInputElement).value;
  searchDebounce = setTimeout(() => runSearch(query), 250);
});
document.getElementById("users-prev-btn")!.addEventListener("click", () => {
  if (currentUsersPage > 1) loadAllUsers(currentUsersPage - 1);
});
document.getElementById("users-next-btn")!.addEventListener("click", () => {
  loadAllUsers(currentUsersPage + 1);
});

async function init(): Promise<void> {
  const result = await request<{ history: HistoryRow[] }>("/history");
  if (result.ok) {
    showPanelView();
    renderHistory(result.data.history);
    await loadAllUsers(1);
  } else {
    showLoginView();
  }
}

init();
