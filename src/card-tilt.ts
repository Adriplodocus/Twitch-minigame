const MAX_TILT_DEG = 12;

let handlerAttached = false;

export function ensureCardTiltHandler(): void {
  if (typeof window === "undefined") return;
  if (handlerAttached) return;
  handlerAttached = true;

  const canTilt =
    window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!canTilt) return;

  document.addEventListener("pointermove", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".card.foil");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const rotateY = (x - 0.5) * MAX_TILT_DEG * 2;
    const rotateX = (0.5 - y) * MAX_TILT_DEG * 2;
    card.classList.add("tilting");
    card.style.transform = `perspective(600px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.04)`;
    const glare = card.querySelector<HTMLElement>(".glare");
    if (glare) {
      glare.style.background = `radial-gradient(circle at ${x * 100}% ${y * 100}%, rgba(255,255,255,0.65), transparent 55%)`;
    }
  });

  document.addEventListener("pointerout", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".card.foil");
    if (!card) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && card.contains(related)) return;
    card.classList.remove("tilting");
    card.style.transform = "";
    const glare = card.querySelector<HTMLElement>(".glare");
    if (glare) glare.style.background = "transparent";
  });
}
