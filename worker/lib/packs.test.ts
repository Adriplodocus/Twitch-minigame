import { describe, expect, it } from "vitest";
import { pickRandomCards } from "./packs";

interface TestCard {
  id: string;
  rarity: "common" | "rare" | "epic" | "legendary";
}

function sequenceRandom(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("pickRandomCards", () => {
  it("throws on an empty catalog", () => {
    expect(() => pickRandomCards([], 1)).toThrow();
  });

  it("picks shiny cards ~10% of the time within a rarity, uniform among non-shiny", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common" },
      { id: "p2", rarity: "common" },
      { id: "p3", rarity: "common" },
      { id: "p1-shiny", rarity: "common" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, sequenceRandom(rolls));
    const shinyCount = picks.filter((c) => c.id === "p1-shiny").length;
    const shinyRatio = shinyCount / picks.length;
    expect(shinyRatio).toBeGreaterThan(0.08);
    expect(shinyRatio).toBeLessThan(0.12);

    const p1 = picks.filter((c) => c.id === "p1").length;
    const p2 = picks.filter((c) => c.id === "p2").length;
    const p3 = picks.filter((c) => c.id === "p3").length;
    expect(p1).toBeCloseTo(p2, -2);
    expect(p2).toBeCloseTo(p3, -2);
  });

  it("gives shiny cards 0% chance if none exist for that rarity", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "rare" },
      { id: "p2", rarity: "rare" },
    ];
    const picks = pickRandomCards(catalog, 100, () => 0.99);
    expect(picks.every((c) => !c.id.includes("-shiny"))).toBe(true);
  });

  it("still picks shiny cards if a rarity has only shiny variants", () => {
    const catalog: TestCard[] = [{ id: "p1-shiny", rarity: "legendary" }];
    const picks = pickRandomCards(catalog, 5, () => 0.5);
    expect(picks.every((c) => c.id === "p1-shiny")).toBe(true);
  });

  it("respects rarity weights across tiers", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common" },
      { id: "p2", rarity: "legendary" },
    ];
    // common weight 70, legendary weight 5 -> common cutoff at roll < 70/75
    const picks = pickRandomCards(catalog, 1, () => 0.5);
    expect(picks[0].id).toBe("p1");

    const legendaryPick = pickRandomCards(catalog, 1, () => 0.99);
    expect(legendaryPick[0].id).toBe("p2");
  });
});
