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
  const streakFill = document.getElementById("daily-streak-fill");
  const streakGoal = document.getElementById("daily-streak-goal");
  if (dailyPackBtn) {
    const markClaimed = () => {
      dailyPackBtn.disabled = true;
      dailyPackBtn.classList.add("claimed");
    };

    const renderStreak = (streak: number) => {
      if (!streakFill || !streakGoal) return;
      const streakInWeek = streak === 0 ? 0 : ((streak - 1) % 7) + 1;
      streakFill.style.width = `${(streakInWeek / 7) * 100}%`;
      streakGoal.classList.toggle("reached", streakInWeek === 7);
    };

    getDailyPackStatus().then(({ claimed, streak }) => {
      if (claimed) markClaimed();
      renderStreak(streak);
    });

    dailyPackBtn.addEventListener("click", async () => {
      try {
        const { streak } = await claimDailyPack();
        markClaimed();
        renderStreak(streak);
        document.dispatchEvent(new Event("daily-pack-claimed"));
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
