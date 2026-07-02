import type { Category, Rarity } from "../types";

export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 70,
  rare: 15,
  epic: 10,
  legendary: 5,
};

export const SHINY_CHANCE = 0.01;

export const CATEGORY_WEIGHTS: Record<Exclude<Category, "normal">, number> = {
  inicial: 0.15,
  mega: 0.1,
  gmax: 0.1,
};

export function isShinyCard(id: string): boolean {
  return id.includes("-shiny");
}

function splitShinyWeight(rarityWeight: number, shinyCount: number, nonShinyCount: number, shiny: boolean): number {
  if (shinyCount === 0) return shiny ? 0 : rarityWeight / nonShinyCount;
  if (nonShinyCount === 0) return shiny ? rarityWeight / shinyCount : 0;
  return shiny ? (rarityWeight * SHINY_CHANCE) / shinyCount : (rarityWeight * (1 - SHINY_CHANCE)) / nonShinyCount;
}

function buildCardWeights<T extends { id: string; rarity: Rarity; category: Category }>(
  catalog: T[]
): Map<T, number> {
  // Count cards per (rarity, category) bucket, split further into shiny/non-shiny.
  const countsByRarityCategory = new Map<Rarity, Map<Category, { shiny: number; nonShiny: number }>>();
  for (const card of catalog) {
    let byCategory = countsByRarityCategory.get(card.rarity);
    if (!byCategory) {
      byCategory = new Map();
      countsByRarityCategory.set(card.rarity, byCategory);
    }
    let counts = byCategory.get(card.category);
    if (!counts) {
      counts = { shiny: 0, nonShiny: 0 };
      byCategory.set(card.category, counts);
    }
    if (isShinyCard(card.id)) counts.shiny++;
    else counts.nonShiny++;
  }

  const weights = new Map<T, number>();
  for (const [rarity, byCategory] of countsByRarityCategory) {
    const rarityWeight = RARITY_WEIGHTS[rarity];

    // Only categories that actually have >=1 card in this rarity reserve their budget;
    // absent categories fold their share entirely into "normal".
    let normalFraction = 1;
    for (const [category, weightFraction] of Object.entries(CATEGORY_WEIGHTS) as [Exclude<Category, "normal">, number][]) {
      if (byCategory.has(category)) normalFraction -= weightFraction;
    }

    for (const [category, counts] of byCategory) {
      const categoryFraction = category === "normal" ? normalFraction : CATEGORY_WEIGHTS[category];
      const categoryBudget = rarityWeight * categoryFraction;

      for (const card of catalog) {
        if (card.rarity !== rarity || card.category !== category) continue;
        const shiny = isShinyCard(card.id);
        weights.set(card, splitShinyWeight(categoryBudget, counts.shiny, counts.nonShiny, shiny));
      }
    }
  }
  return weights;
}

export function pickRandomCards<T extends { id: string; rarity: Rarity; category: Category }>(
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
