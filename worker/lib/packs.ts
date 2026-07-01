import type { Rarity } from "../types";

export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 60,
  rare: 25,
  epic: 12,
  legendary: 3,
};

export function pickRandomCards<T extends { id: string; rarity: Rarity }>(
  catalog: T[],
  count: number,
  random: () => number = Math.random
): T[] {
  if (catalog.length === 0) throw new Error("Catalog is empty");
  const totalWeight = catalog.reduce((sum, card) => sum + RARITY_WEIGHTS[card.rarity], 0);
  const picks: T[] = [];
  for (let i = 0; i < count; i++) {
    let roll = random() * totalWeight;
    let chosen = catalog[catalog.length - 1];
    for (const card of catalog) {
      roll -= RARITY_WEIGHTS[card.rarity];
      if (roll <= 0) {
        chosen = card;
        break;
      }
    }
    picks.push(chosen);
  }
  return picks;
}
