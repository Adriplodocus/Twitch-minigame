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
let activeFooterRect: DOMRect | null = null;

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

// Same as resetTilt, but skips the card's eased transform transition. Used
// when the pointer crosses into the footer dead zone: an eased snap-back
// would leave the info-btn's hit box mid-flight for the ~0.35s transition,
// so a click right after entering the footer could still land on the
// pre-reset (tilted) geometry. The footer needs to be flat immediately.
function resetTiltInstant(card: HTMLElement): void {
  const prevTransition = card.style.transition;
  card.style.transition = "none";
  resetTilt(card);
  card.getBoundingClientRect(); // force layout so the transition-less reset paints
  card.style.transition = prevTransition;
}

export function ensureCardTiltHandler(): void {
  if (typeof window === "undefined") return;
  if (handlerAttached) return;
  handlerAttached = true;

  const canTilt =
    window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!canTilt) return;

  // The footer (info button, qty badge) is a dead zone for tilt: keeping it
  // flat means its hit box stays where the user's cursor actually is, so a
  // click on the tiny info-btn doesn't miss because the 3D transform shifted
  // that corner away underneath the pointer. Whether the pointer is "over
  // the footer" is checked against this cached FLAT rect, not via
  // e.target.closest(".card-footer") — once the card is tilted, hit-testing
  // is resolved against its rendered (transformed) geometry, which is
  // exactly the corner the tilt has shifted away, so closest() misses the
  // footer at the same coordinate a flat check would still catch.
  const inRect = (x: number, y: number, rect: DOMRect): boolean =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

  document.addEventListener("pointermove", (e) => {
    if (activeCard && activeRect) {
      const inBounds = inRect(e.clientX, e.clientY, activeRect);
      const overFooter = activeFooterRect && inRect(e.clientX, e.clientY, activeFooterRect);
      if (inBounds && !overFooter) {
        applyTilt(activeCard, activeRect, e.clientX, e.clientY);
        return;
      }
      if (inBounds && overFooter) {
        resetTiltInstant(activeCard);
        activeCard = null;
        activeRect = null;
        activeFooterRect = null;
        return;
      }
      resetTilt(activeCard);
      activeCard = null;
      activeRect = null;
      activeFooterRect = null;
    }

    const card = (e.target as HTMLElement).closest<HTMLElement>(".card.tiltable");
    if (!card) return;
    const footer = card.querySelector<HTMLElement>(".card-footer");
    const footerRect = footer?.getBoundingClientRect() ?? null;
    if (footerRect && inRect(e.clientX, e.clientY, footerRect)) return;
    activeCard = card;
    activeRect = card.getBoundingClientRect();
    activeFooterRect = footerRect;
    applyTilt(card, activeRect, e.clientX, e.clientY);
  });

  // Catches the pointer leaving the document/window entirely (pointermove
  // stops firing in that case, so the bounds check above never runs).
  document.addEventListener("pointerout", (e) => {
    if (!activeCard || e.relatedTarget !== null) return;
    resetTilt(activeCard);
    activeCard = null;
    activeRect = null;
    activeFooterRect = null;
  });
}
