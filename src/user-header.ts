import { getMe, logout } from "./api";

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
}
