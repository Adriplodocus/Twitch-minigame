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
let activeInfoBtnRect: DOMRect | null = null;

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
// when the pointer crosses onto the info-btn: an eased snap-back would
// leave its hit box mid-flight for the ~0.35s transition, so a click right
// after arriving could still land on the pre-reset (tilted) geometry. It
// needs to be flat immediately.
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

  const inRect = (x: number, y: number, rect: DOMRect): boolean =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

  document.addEventListener("pointermove", (e) => {
    if (activeCard && activeRect) {
      const inBounds = inRect(e.clientX, e.clientY, activeRect);
      // The click event's target is resolved by the browser's native
      // hit-test at mousedown time, before any JS runs — so flattening
      // reactively on pointerdown/click is always too late once the pointer
      // is already sitting over the (displaced) tilted geometry. The only
      // way to guarantee an accurate hit-test is for the info-btn to already
      // be flat *before* the press happens. Scoped to just the button's own
      // small rect (not the whole footer) so the rest of the card — footer
      // included — still tilts normally right up until the pointer is on
      // top of the button itself.
      const overInfoBtn = activeInfoBtnRect && inRect(e.clientX, e.clientY, activeInfoBtnRect);
      if (inBounds && !overInfoBtn) {
        applyTilt(activeCard, activeRect, e.clientX, e.clientY);
        return;
      }
      if (inBounds && overInfoBtn) {
        resetTiltInstant(activeCard);
        activeCard = null;
        activeRect = null;
        activeInfoBtnRect = null;
        return;
      }
      resetTilt(activeCard);
      activeCard = null;
      activeRect = null;
      activeInfoBtnRect = null;
    }

    const card = (e.target as HTMLElement).closest<HTMLElement>(".card.tiltable");
    if (!card) return;
    const infoBtn = card.querySelector<HTMLElement>(".info-btn");
    const infoBtnRect = infoBtn?.getBoundingClientRect() ?? null;
    if (infoBtnRect && inRect(e.clientX, e.clientY, infoBtnRect)) return;
    activeCard = card;
    activeRect = card.getBoundingClientRect();
    activeInfoBtnRect = infoBtnRect;
    applyTilt(card, activeRect, e.clientX, e.clientY);
  });

  // Catches the pointer leaving the document/window entirely (pointermove
  // stops firing in that case, so the bounds check above never runs).
  document.addEventListener("pointerout", (e) => {
    if (!activeCard || e.relatedTarget !== null) return;
    resetTilt(activeCard);
    activeCard = null;
    activeRect = null;
    activeInfoBtnRect = null;
  });
}
