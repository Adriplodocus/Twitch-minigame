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

  it("escapes HTML in message and link to prevent XSS", () => {
    const html = renderNotificationList([
      {
        id: 3,
        message: `<script>alert('xss')</script>`,
        link: `/redirect?next="><img src=x onerror=alert(1)>`,
        read: false,
        createdAt: "2026-01-01",
      },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain(`"><img`);
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("renders a notification with a non-relative link (e.g. javascript:) as a non-clickable div", () => {
    const html = renderNotificationList([
      {
        id: 4,
        message: "Malicioso",
        link: "javascript:alert(1)",
        read: false,
        createdAt: "2026-01-01",
      },
    ]);
    expect(html).toContain("<div");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Malicioso");
  });
});
