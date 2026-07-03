const MAX_TILT_DEG = 12;

let handlerAttached = false;

// getBoundingClientRect() reports a card's post-transform (rendered) box.
// Once tilted, the card's *rendered* footprint is rotated/foreshortened
// away from its flat layout rect — so native hit-testing (what `closest()`
// resolves against) can decide the pointer has left the card while it's
// still within the original flat rect, firing a real pointerout. That
// resets the tilt, which un-rotates the card back under the pointer,
// which immediately re-triggers pointermove/tilt — a flicker loop. Worse
// inside the album's nested 3D perspective, where the rendered footprint
// shifts more per degree of rotation.
//
// Fix: once a card is active, stop relying on hit-testing entirely and
// track containment against the cached flat rect directly.
let activeCard: HTMLElement | null = null;
let activeRect: DOMRect | null = null;

function applyTilt(card: HTMLElement, rect: DOMRect, clientX: number, clientY: number): void {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const rotateY = (x - 0.5) * MAX_TILT_DEG * 2;
  const rotateX = (0.5 - y) * MAX_TILT_DEG * 2;
  card.classList.add("tilting");
  card.style.transform = `perspective(600px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.04)`;
  const glare = card.querySelector<HTMLElement>(".glare");
  if (glare) {
    glare.style.background = `radial-gradient(circle at ${x * 100}% ${y * 100}%, rgba(255,255,255,0.65), transparent 55%)`;
  }
}

function resetTilt(card: HTMLElement): void {
  card.classList.remove("tilting");
  card.style.transform = "";
  const glare = card.querySelector<HTMLElement>(".glare");
  if (glare) glare.style.background = "transparent";
}

export function ensureCardTiltHandler(): void {
  if (typeof window === "undefined") return;
  if (handlerAttached) return;
  handlerAttached = true;

  const canTilt =
    window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!canTilt) return;

  document.addEventListener("pointermove", (e) => {
    if (activeCard && activeRect) {
      const inBounds =
        e.clientX >= activeRect.left &&
        e.clientX <= activeRect.right &&
        e.clientY >= activeRect.top &&
        e.clientY <= activeRect.bottom;
      if (inBounds) {
        applyTilt(activeCard, activeRect, e.clientX, e.clientY);
        return;
      }
      resetTilt(activeCard);
      activeCard = null;
      activeRect = null;
    }

    const card = (e.target as HTMLElement).closest<HTMLElement>(".card.tiltable");
    if (!card) return;
    activeCard = card;
    activeRect = card.getBoundingClientRect();
    applyTilt(card, activeRect, e.clientX, e.clientY);
  });

  // Catches the pointer leaving the document/window entirely (pointermove
  // stops firing in that case, so the bounds check above never runs).
  document.addEventListener("pointerout", (e) => {
    if (!activeCard || e.relatedTarget !== null) return;
    resetTilt(activeCard);
    activeCard = null;
    activeRect = null;
  });
}
