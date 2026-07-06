const STORAGE_KEY = "soundMuted";

export function isMuted(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function toggleMuted(): boolean {
  const next = !isMuted();
  localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  return next;
}
