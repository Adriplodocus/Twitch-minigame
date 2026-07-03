import { getMe, getPendingOfferCount, logout } from "./api";

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
