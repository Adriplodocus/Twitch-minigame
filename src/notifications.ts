import { getUnreadNotifications, listNotifications, type NotificationView } from "./api";

export function renderNotificationList(items: NotificationView[]): string {
  if (items.length === 0) return `<p class="notif-empty">Sin notificaciones</p>`;
  return items
    .map((n) => {
      const tag = n.link ? "a" : "div";
      const href = n.link ? ` href="${n.link}"` : "";
      return `<${tag} class="notif-item"${href} data-id="${n.id}">${n.message}</${tag}>`;
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
    const { notifications } = await listNotifications();
    panel.innerHTML = renderNotificationList(notifications);
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
