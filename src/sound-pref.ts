const STORAGE_KEY = "soundMuted";

// No per-user control for this yet — just a flat cut on every website sound
// effect (pack reveal cries/shiny, album page flip). Tune by feel.
export const SOUND_VOLUME = 0.3;

export function isMuted(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function toggleMuted(): boolean {
  const next = !isMuted();
  localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  return next;
}

/** Resolves once the sound finishes playing (or immediately if muted/blocked),
 * so callers can wait out the sound before moving on. */
export function playSound(src: string): Promise<void> {
  if (isMuted()) return Promise.resolve();
  const audio = new Audio(src);
  audio.volume = SOUND_VOLUME;
  return new Promise((resolve) => {
    audio.addEventListener("ended", () => resolve(), { once: true });
    audio.addEventListener("error", () => resolve(), { once: true });
    audio.play().catch(() => resolve());
  });
}
