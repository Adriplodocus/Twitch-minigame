import { describe, it, expect } from "vitest";
import { renderNotificationList } from "./notifications";

describe("renderNotificationList", () => {
  it("renders a placeholder when there are no notifications", () => {
    expect(renderNotificationList([])).toContain("Sin notificaciones");
  });

  it("renders a notification without a link as a non-clickable div", () => {
    const html = renderNotificationList([
      { id: 1, message: "Hola", link: null, read: false, createdAt: "2026-01-01" },
    ]);
    expect(html).toContain("<div");
    expect(html).toContain("Hola");
    expect(html).not.toContain("<a");
  });

  it("renders a notification with a link as a clickable anchor", () => {
    const html = renderNotificationList([
      {
        id: 2,
        message: "Oferta aceptada",
        link: "/marketplace.html?tab=mine",
        read: false,
        createdAt: "2026-01-01",
      },
    ]);
    expect(html).toContain('<a class="notif-item" href="/marketplace.html?tab=mine"');
    expect(html).toContain("Oferta aceptada");
  });
});
