import type { Rarity } from "../types";

export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 70,
  rare: 15,
  epic: 10,
  legendary: 5,
};

export const SHINY_CHANCE = 0.1;

export function isShinyCard(id: string): boolean {
  return id.includes("-shiny");
}

function buildCardWeights<T extends { id: string; rarity: Rarity }>(catalog: T[]): Map<T, number> {
  const shinyCountByRarity = new Map<Rarity, number>();
  const nonShinyCountByRarity = new Map<Rarity, number>();
  for (const card of catalog) {
    const counts = isShinyCard(card.id) ? shinyCountByRarity : nonShinyCountByRarity;
    counts.set(card.rarity, (counts.get(card.rarity) ?? 0) + 1);
  }

  const weights = new Map<T, number>();
  for (const card of catalog) {
    const shinyCount = shinyCountByRarity.get(card.rarity) ?? 0;
    const nonShinyCount = nonShinyCountByRarity.get(card.rarity) ?? 0;
    const rarityWeight = RARITY_WEIGHTS[card.rarity];
    const shiny = isShinyCard(card.id);

    let weight: number;
    if (shinyCount === 0) {
      weight = shiny ? 0 : rarityWeight / nonShinyCount;
    } else if (nonShinyCount === 0) {
      weight = shiny ? rarityWeight / shinyCount : 0;
    } else {
      weight = shiny ? (rarityWeight * SHINY_CHANCE) / shinyCount : (rarityWeight * (1 - SHINY_CHANCE)) / nonShinyCount;
    }
    weights.set(card, weight);
  }
  return weights;
}

export function pickRandomCards<T extends { id: string; rarity: Rarity }>(
  catalog: T[],
  count: number,
  random: () => number = Math.random
): T[] {
  if (catalog.length === 0) throw new Error("Catalog is empty");
  const weights = buildCardWeights(catalog);
  const totalWeight = catalog.reduce((sum, card) => sum + weights.get(card)!, 0);
  const picks: T[] = [];
  for (let i = 0; i < count; i++) {
    let roll = random() * totalWeight;
    let chosen = catalog[catalog.length - 1];
    for (const card of catalog) {
      roll -= weights.get(card)!;
      if (roll <= 0) {
        chosen = card;
        break;
      }
    }
    picks.push(chosen);
  }
  return picks;
}
