const MAX_TILT_DEG = 12;

let handlerAttached = false;

// getBoundingClientRect() reports the card's post-transform (rendered) box,
// not its flat layout box. Re-measuring it on every pointermove once a
// rotation is already applied feeds that rotated geometry back into the
// next rotation calculation — a feedback loop that shows up as jitter/reset,
// especially inside the album's nested 3D perspective. Measure the flat
// rect once per hover session (before any transform is applied) and reuse
// it until the pointer leaves.
let activeCard: HTMLElement | null = null;
let activeRect: DOMRect | null = null;

export function ensureCardTiltHandler(): void {
  if (typeof window === "undefined") return;
  if (handlerAttached) return;
  handlerAttached = true;

  const canTilt =
    window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!canTilt) return;

  document.addEventListener("pointermove", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".card.tiltable");
    if (!card) return;
    if (card !== activeCard) {
      activeCard = card;
      activeRect = card.getBoundingClientRect();
    }
    const rect = activeRect!;
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
    const card = (e.target as HTMLElement).closest<HTMLElement>(".card.tiltable");
    if (!card) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && card.contains(related)) return;
    card.classList.remove("tilting");
    card.style.transform = "";
    const glare = card.querySelector<HTMLElement>(".glare");
    if (glare) glare.style.background = "transparent";
    if (card === activeCard) {
      activeCard = null;
      activeRect = null;
    }
  });
}
