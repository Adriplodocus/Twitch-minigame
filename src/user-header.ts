import { getMe, getPendingOfferCount, getDailyPackStatus, claimDailyPack, logout } from "./api";

export function initUserHeader(): void {
  document.getElementById("logout-btn")!.addEventListener("click", async () => {
    await logout();
    window.location.href = "/";
  });

  getMe().then((me) => {
    document.getElementById("user-name")!.textContent = me.username;
    const avatar = document.getElementById("user-avatar") as HTMLImageElement | null;
    if (avatar) {
      avatar.alt = me.username;
      if (me.avatarUrl) avatar.src = me.avatarUrl;
    }
  });

  const howToBtn = document.getElementById("how-to-btn");
  const howToPanel = document.getElementById("how-to-panel");
  if (howToBtn && howToPanel) {
    const close = () => {
      howToPanel.hidden = true;
      howToBtn.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      howToPanel.hidden = false;
      howToBtn.setAttribute("aria-expanded", "true");
    };
    howToBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (howToPanel.hidden) open();
      else close();
    });
    document.addEventListener("click", (e) => {
      if (!howToPanel.hidden && !howToPanel.contains(e.target as Node) && e.target !== howToBtn) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  }

  const dailyPackBtn = document.getElementById("daily-pack-btn") as HTMLButtonElement | null;
  if (dailyPackBtn) {
    const markClaimed = () => {
      dailyPackBtn.disabled = true;
      dailyPackBtn.textContent = "✅ Sobre reclamado hoy";
    };

    getDailyPackStatus().then(({ claimed }) => {
      if (claimed) markClaimed();
    });

    dailyPackBtn.addEventListener("click", async () => {
      try {
        await claimDailyPack();
        markClaimed();
      } catch {
        markClaimed();
      }
    });
  }

  const offersLink = document.querySelector<HTMLAnchorElement>('a[href="/offers.html"]');
  if (offersLink) {
    getPendingOfferCount().then(({ count }) => {
      if (count > 0) {
        const dot = document.createElement("span");
        dot.className = "notif-dot";
        offersLink.appendChild(dot);
      }
    });
  }
}
