import type { PendingPack } from "./api";

export function shouldShowFoil(tier: PendingPack["tier"]): boolean {
  return tier === "apoyo";
}
