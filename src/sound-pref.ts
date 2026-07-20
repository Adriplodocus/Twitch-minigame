const STORAGE_KEY = "soundMuted";

// No per-user control for this yet — just a flat cut on every website sound
// effect (pack reveal cries/shiny, album page flip). Tune by feel.
export const SOUND_VOLUME = 0.6;

export function isMuted(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function toggleMuted(): boolean {
  const next = !isMuted();
  localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  return next;
}

export function playSound(src: string): void {
  if (isMuted()) return;
  const audio = new Audio(src);
  audio.volume = SOUND_VOLUME;
  audio.play().catch(() => {});
}
