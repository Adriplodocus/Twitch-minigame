import { getMe } from "./api";

export function attachTradeLinkButton(buttonId: string): void {
  const btn = document.getElementById(buttonId) as HTMLButtonElement;
  const originalLabel = btn.textContent;
  btn.addEventListener("click", async () => {
    const { username } = await getMe();
    const url = `${window.location.origin}/trade.html?with=${encodeURIComponent(username)}`;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "¡Copiado!";
    } catch {
      window.prompt("Copiá tu enlace de trade:", url);
    }
    setTimeout(() => {
      btn.textContent = originalLabel;
    }, 1500);
  });
}
