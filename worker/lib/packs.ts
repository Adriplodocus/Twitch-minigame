import type { Category, Rarity } from "../types";

export type PackTier = "gratis" | "apoyo";

export const RARITY_WEIGHTS_BY_TIER: Record<PackTier, Record<Rarity, number>> = {
  gratis: { common: 71.5, rare: 15, epic: 12, legendary: 1.5 },
  apoyo: { common: 60, rare: 20, epic: 16, legendary: 4 },
};

export const SHINY_CHANCE_BY_TIER: Record<PackTier, number> = {
  gratis: 0.005,
  apoyo: 0.01,
};

export const CATEGORY_WEIGHTS: Record<Exclude<Category, "normal">, number> = {
  inicial: 0.05,
  mega: 0.03,
  gmax: 0.03,
};

export function isShinyCard(id: string): boolean {
  return id.includes("-shiny");
}

function splitShinyWeight(
  rarityWeight: number,
  shinyCount: number,
  nonShinyCount: number,
  shiny: boolean,
  shinyChance: number
): number {
  if (shinyCount === 0) return shiny ? 0 : rarityWeight / nonShinyCount;
  if (nonShinyCount === 0) return shiny ? rarityWeight / shinyCount : 0;
  return shiny ? (rarityWeight * shinyChance) / shinyCount : (rarityWeight * (1 - shinyChance)) / nonShinyCount;
}

function buildCardWeights<T extends { id: string; rarity: Rarity; category: Category }>(
  catalog: T[],
  tier: PackTier
): Map<T, number> {
  const rarityWeights = RARITY_WEIGHTS_BY_TIER[tier];
  const shinyChance = SHINY_CHANCE_BY_TIER[tier];

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
    const rarityWeight = rarityWeights[rarity];

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
        weights.set(card, splitShinyWeight(categoryBudget, counts.shiny, counts.nonShiny, shiny, shinyChance));
      }
    }
  }
  return weights;
}

export interface ExactCounts {
  common: number;
  rare: number;
  epic: number;
  legendary: number;
  shiny: number;
}

const NON_SHINY_RARITIES: Rarity[] = ["common", "rare", "epic", "legendary"];

export function pickExactCards<T extends { id: string; rarity: Rarity }>(
  catalog: T[],
  counts: ExactCounts,
  random: () => number = Math.random
): T[] {
  const picks: T[] = [];

  for (const rarity of NON_SHINY_RARITIES) {
    const count = counts[rarity];
    if (count === 0) continue;
    const pool = catalog.filter((card) => card.rarity === rarity && !isShinyCard(card.id));
    if (pool.length === 0) throw new Error(`No hay cartas ${rarity} no-shiny en esta generación`);
    for (let i = 0; i < count; i++) {
      picks.push(pool[Math.floor(random() * pool.length)]);
    }
  }

  if (counts.shiny > 0) {
    const shinyPool = catalog.filter((card) => isShinyCard(card.id));
    if (shinyPool.length === 0) throw new Error("No hay cartas shiny en esta generación");
    for (let i = 0; i < counts.shiny; i++) {
      picks.push(shinyPool[Math.floor(random() * shinyPool.length)]);
    }
  }

  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }

  return picks;
}

export function pickRandomCards<T extends { id: string; rarity: Rarity; category: Category }>(
  catalog: T[],
  count: number,
  tier: PackTier,
  random: () => number = Math.random
): T[] {
  if (catalog.length === 0) throw new Error("Catalog is empty");
  const weights = buildCardWeights(catalog, tier);
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
