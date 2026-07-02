import { describe, expect, it } from "vitest";
import { pickRandomCards } from "./packs";

interface TestCard {
  id: string;
  rarity: "common" | "rare" | "epic" | "legendary";
  category: "normal" | "inicial" | "mega" | "gmax";
}

function sequenceRandom(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("pickRandomCards", () => {
  it("throws on an empty catalog", () => {
    expect(() => pickRandomCards([], 1)).toThrow();
  });

  it("picks shiny cards ~1% of the time within a rarity, uniform among non-shiny", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal" },
      { id: "p2", rarity: "common", category: "normal" },
      { id: "p3", rarity: "common", category: "normal" },
      { id: "p1-shiny", rarity: "common", category: "normal" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, sequenceRandom(rolls));
    const shinyCount = picks.filter((c) => c.id === "p1-shiny").length;
    const shinyRatio = shinyCount / picks.length;
    expect(shinyRatio).toBeGreaterThan(0.005);
    expect(shinyRatio).toBeLessThan(0.015);

    const p1 = picks.filter((c) => c.id === "p1").length;
    const p2 = picks.filter((c) => c.id === "p2").length;
    const p3 = picks.filter((c) => c.id === "p3").length;
    expect(p1).toBeCloseTo(p2, -2);
    expect(p2).toBeCloseTo(p3, -2);
  });

  it("gives shiny cards 0% chance if none exist for that rarity", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "rare", category: "normal" },
      { id: "p2", rarity: "rare", category: "normal" },
    ];
    const picks = pickRandomCards(catalog, 100, () => 0.99);
    expect(picks.every((c) => !c.id.includes("-shiny"))).toBe(true);
  });

  it("still picks shiny cards if a rarity has only shiny variants", () => {
    const catalog: TestCard[] = [{ id: "p1-shiny", rarity: "legendary", category: "normal" }];
    const picks = pickRandomCards(catalog, 5, () => 0.5);
    expect(picks.every((c) => c.id === "p1-shiny")).toBe(true);
  });

  it("respects rarity weights across tiers", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal" },
      { id: "p2", rarity: "legendary", category: "normal" },
    ];
    // common weight 70, legendary weight 5 -> common cutoff at roll < 70/75
    const picks = pickRandomCards(catalog, 1, () => 0.5);
    expect(picks[0].id).toBe("p1");

    const legendaryPick = pickRandomCards(catalog, 1, () => 0.99);
    expect(legendaryPick[0].id).toBe("p2");
  });

  it("splits a rarity's weight budget across categories ~65/15/10/10 (normal/inicial/mega/gmax)", () => {
    const catalog: TestCard[] = [
      { id: "normal1", rarity: "common", category: "normal" },
      { id: "inicial1", rarity: "common", category: "inicial" },
      { id: "mega1", rarity: "common", category: "mega" },
      { id: "gmax1", rarity: "common", category: "gmax" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, sequenceRandom(rolls));
    const ratio = (id: string) => picks.filter((c) => c.id === id).length / picks.length;

    expect(ratio("normal1")).toBeGreaterThan(0.63);
    expect(ratio("normal1")).toBeLessThan(0.67);
    expect(ratio("inicial1")).toBeGreaterThan(0.13);
    expect(ratio("inicial1")).toBeLessThan(0.17);
    expect(ratio("mega1")).toBeGreaterThan(0.08);
    expect(ratio("mega1")).toBeLessThan(0.12);
    expect(ratio("gmax1")).toBeGreaterThan(0.08);
    expect(ratio("gmax1")).toBeLessThan(0.12);
  });

  it("folds an absent category's weight budget entirely into normal for that rarity", () => {
    // No "mega" or "gmax" cards exist for "rare" — their 10%+10% should fold into normal, not vanish.
    const catalog: TestCard[] = [
      { id: "normal1", rarity: "rare", category: "normal" },
      { id: "inicial1", rarity: "rare", category: "inicial" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, sequenceRandom(rolls));
    const ratio = (id: string) => picks.filter((c) => c.id === id).length / picks.length;

    // normal should get 100% - 15% (inicial) = 85%, not 65%, since mega/gmax are absent
    expect(ratio("normal1")).toBeGreaterThan(0.83);
    expect(ratio("normal1")).toBeLessThan(0.87);
    expect(ratio("inicial1")).toBeGreaterThan(0.13);
    expect(ratio("inicial1")).toBeLessThan(0.17);
  });

  it("applies shiny ~1% within a non-normal category too", () => {
    const catalog: TestCard[] = [
      { id: "mega1", rarity: "epic", category: "mega" },
      { id: "mega1-shiny", rarity: "epic", category: "mega" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, sequenceRandom(rolls));
    const shinyRatio = picks.filter((c) => c.id === "mega1-shiny").length / picks.length;
    expect(shinyRatio).toBeGreaterThan(0.005);
    expect(shinyRatio).toBeLessThan(0.015);
  });
});
