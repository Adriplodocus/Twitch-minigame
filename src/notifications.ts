import { getUnreadNotifications, listNotifications, type NotificationView } from "./api";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeNotificationLink(link: string): boolean {
  // Only allow same-origin/relative paths. Absolute URLs (including
  // javascript:, data:, http:, etc.) are rejected outright — no scheme
  // allow-listing, just "starts with /".
  return link.startsWith("/");
}

export function renderNotificationList(items: NotificationView[]): string {
  if (items.length === 0) return `<p class="notif-empty">Sin notificaciones</p>`;
  return items
    .map((n) => {
      const safeLink = n.link && isSafeNotificationLink(n.link) ? n.link : null;
      const tag = safeLink ? "a" : "div";
      const href = safeLink ? ` href="${escapeHtml(safeLink)}"` : "";
      return `<${tag} class="notif-item"${href} data-id="${n.id}">${escapeHtml(n.message)}</${tag}>`;
    })
    .join("");
}

export function initNotifications(headerUser: Element): void {
  const bellBtn = document.createElement("button");
  bellBtn.className = "icon-btn notif-bell";
  bellBtn.type = "button";
  bellBtn.setAttribute("aria-haspopup", "true");
  bellBtn.setAttribute("aria-expanded", "false");
  bellBtn.setAttribute("aria-label", "Notificaciones");
  bellBtn.textContent = "🔔";

  const dot = document.createElement("span");
  dot.className = "notif-dot";
  dot.hidden = true;
  bellBtn.appendChild(dot);

  const panel = document.createElement("div");
  panel.className = "notif-panel";
  panel.hidden = true;

  const userName = headerUser.querySelector("#user-name");
  headerUser.insertBefore(bellBtn, userName);
  headerUser.insertBefore(panel, userName);

  const close = () => {
    panel.hidden = true;
    bellBtn.setAttribute("aria-expanded", "false");
  };
  const open = async () => {
    panel.hidden = false;
    bellBtn.setAttribute("aria-expanded", "true");
    dot.hidden = true;
    try {
      const { notifications } = await listNotifications();
      panel.innerHTML = renderNotificationList(notifications);
    } catch (err) {
      console.error("Failed to load notifications", err);
      panel.innerHTML = `<p class="notif-empty">Error al cargar notificaciones</p>`;
    }
  };

  bellBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.hidden) open();
    else close();
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node) && e.target !== bellBtn) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  getUnreadNotifications().then(({ unread }) => {
    dot.hidden = !unread;
  });
}
