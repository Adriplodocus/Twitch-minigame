import { getMe, getPendingOfferCount, getDailyPackStatus, claimDailyPack, logout } from "./api";
import { isMuted, toggleMuted } from "./sound-pref";
import { initNotifications } from "./notifications";

export function initUserHeader(): void {
  document.getElementById("logout-btn")!.addEventListener("click", async () => {
    await logout();
    window.location.href = "/";
  });

  const headerUser = document.querySelector(".page-header-user");
  if (headerUser) {
    const muteBtn = document.createElement("button");
    muteBtn.className = "icon-btn";
    muteBtn.type = "button";
    const render = () => {
      const muted = isMuted();
      muteBtn.textContent = muted ? "🔇" : "🔊";
      muteBtn.title = muted ? "Sonido desactivado" : "Sonido activado";
      muteBtn.setAttribute("aria-label", muteBtn.title);
    };
    render();
    muteBtn.addEventListener("click", () => {
      toggleMuted();
      render();
    });
    headerUser.insertBefore(muteBtn, headerUser.firstChild);

    initNotifications(headerUser);
  }

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
    let claimedToday = false;
    let currentStreak = 0;

    const markClaimed = () => {
      claimedToday = true;
      dailyPackBtn.classList.add("claimed");
      const tooltip = dailyPackBtn.querySelector(".daily-pack-tooltip");
      if (tooltip) tooltip.textContent = "Racha";
    };

    const streakInWeek = (streak: number) => (streak === 0 ? 0 : ((streak - 1) % 7) + 1);

    const openStreakModal = (streak: number, milestone: boolean) => {
      const inWeek = streakInWeek(streak);
      const pips = Array.from({ length: 7 }, (_, i) => {
        const day = i + 1;
        const filled = day <= inWeek;
        const isGoal = day === 7;
        const ribbon = isGoal ? '<div class="streak-pip-corner"><div class="streak-pip-ribbon">★</div></div>' : "";
        const check = filled ? '<span class="streak-pip-check">✔</span>' : "";
        return `<div class="streak-pip${filled ? " filled" : ""}${isGoal ? " goal" : ""}">
          <img src="/pack.webp" alt="" />
          ${ribbon}
          ${check}
          <span class="streak-pip-day">${day}</span>
        </div>`;
      }).join("");

      const message = milestone
        ? "¡Enhorabuena! Has recibido un sobre de apoyo por reclamar el sobre diario 7 días seguidos."
        : "¡Enhorabuena! Has recibido un sobre. Vuelve mañana para continuar tu racha.";

      const overlay = document.createElement("div");
      overlay.className = "modal-overlay streak-overlay";
      overlay.innerHTML = `
        <div class="modal streak-modal">
          <img class="streak-modal-icon" src="/Freepack.png" alt="" />
          <h3>Racha: ${streak} día${streak === 1 ? "" : "s"}</h3>
          <div class="streak-pips">${pips}</div>
          <p class="streak-modal-msg">${message}</p>
          <button type="button" class="btn modal-cancel-btn streak-close-btn">Cerrar</button>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKeydown);
      };
      function onKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") close();
      }
      overlay.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target === overlay || target.closest(".streak-close-btn")) close();
      });
      document.addEventListener("keydown", onKeydown);
    };

    getDailyPackStatus().then(({ claimed, streak }) => {
      currentStreak = streak;
      if (claimed) markClaimed();
    });

    dailyPackBtn.addEventListener("click", async () => {
      if (claimedToday) {
        openStreakModal(currentStreak, false);
        return;
      }
      try {
        const { streak, milestone } = await claimDailyPack();
        currentStreak = streak;
        markClaimed();
        openStreakModal(streak, milestone);
        document.dispatchEvent(new Event("daily-pack-claimed"));
      } catch {
        markClaimed();
        openStreakModal(currentStreak, false);
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
