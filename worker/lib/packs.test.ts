import { describe, expect, it } from "vitest";
import { pickRandomCards, RARITY_WEIGHTS_BY_TIER, SHINY_CHANCE_BY_TIER } from "./packs";

interface TestCard {
  id: string;
  rarity: "common" | "rare" | "epic" | "legendary";
  category: "normal" | "inicial" | "mega" | "gmax";
  sortOrder: number;
}

function sequenceRandom(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("pickRandomCards", () => {
  it("throws on an empty catalog", () => {
    expect(() => pickRandomCards([], 1, "gratis")).toThrow();
  });

  it("picks shiny cards ~1% of the time within a rarity (apoyo tier), uniform among non-shiny", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "p2", rarity: "common", category: "normal", sortOrder: 2_000_000 },
      { id: "p3", rarity: "common", category: "normal", sortOrder: 3_000_000 },
      { id: "p1-shiny", rarity: "common", category: "normal", sortOrder: 1_000_000 },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "apoyo", sequenceRandom(rolls));
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

  it("picks shiny cards ~0.5% of the time within a rarity (gratis tier)", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "p1-shiny", rarity: "common", category: "normal", sortOrder: 1_000_000 },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "gratis", sequenceRandom(rolls));
    const shinyRatio = picks.filter((c) => c.id === "p1-shiny").length / picks.length;
    expect(shinyRatio).toBeGreaterThan(0.002);
    expect(shinyRatio).toBeLessThan(0.008);
  });

  it("gives shiny cards 0% chance if none exist for that rarity", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "rare", category: "normal", sortOrder: 1_000_000 },
      { id: "p2", rarity: "rare", category: "normal", sortOrder: 2_000_000 },
    ];
    const picks = pickRandomCards(catalog, 100, "gratis", () => 0.99);
    expect(picks.every((c) => !c.id.includes("-shiny"))).toBe(true);
  });

  it("still picks shiny cards if a rarity has only shiny variants", () => {
    const catalog: TestCard[] = [{ id: "p1-shiny", rarity: "legendary", category: "normal", sortOrder: 1_000_000 }];
    const picks = pickRandomCards(catalog, 5, "gratis", () => 0.5);
    expect(picks.every((c) => c.id === "p1-shiny")).toBe(true);
  });

  it("respects gratis tier rarity weights (common 71.5 vs legendary 1.5)", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "p2", rarity: "legendary", category: "normal", sortOrder: 2_000_000 },
    ];
    // common weight 71.5, legendary weight 1.5, total 73 -> common cutoff at roll < 71.5/73
    const picks = pickRandomCards(catalog, 1, "gratis", () => 0.5);
    expect(picks[0].id).toBe("p1");

    const legendaryPick = pickRandomCards(catalog, 1, "gratis", () => 0.999);
    expect(legendaryPick[0].id).toBe("p2");
  });

  it("gives legendary a noticeably better chance in apoyo tier than gratis tier", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "p2", rarity: "legendary", category: "normal", sortOrder: 2_000_000 },
    ];
    // apoyo: common 60, legendary 4, total 64 -> a roll that stays "common" under gratis
    // (71.5/73 ≈ 0.979) should flip to legendary under apoyo (60/64 = 0.9375).
    const roll = 0.96;
    expect(pickRandomCards(catalog, 1, "gratis", () => roll)[0].id).toBe("p1");
    expect(pickRandomCards(catalog, 1, "apoyo", () => roll)[0].id).toBe("p2");
  });

  it("splits a rarity's weight budget across categories ~89/5/3/3 (normal/inicial/mega/gmax), independent of tier", () => {
    const catalog: TestCard[] = [
      { id: "normal1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "inicial1", rarity: "common", category: "inicial", sortOrder: 2_000_000 },
      { id: "mega1", rarity: "common", category: "mega", sortOrder: 3_000_000 },
      { id: "gmax1", rarity: "common", category: "gmax", sortOrder: 4_000_000 },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "gratis", sequenceRandom(rolls));
    const ratio = (id: string) => picks.filter((c) => c.id === id).length / picks.length;

    expect(ratio("normal1")).toBeGreaterThan(0.87);
    expect(ratio("normal1")).toBeLessThan(0.91);
    expect(ratio("inicial1")).toBeGreaterThan(0.03);
    expect(ratio("inicial1")).toBeLessThan(0.07);
    expect(ratio("mega1")).toBeGreaterThan(0.01);
    expect(ratio("mega1")).toBeLessThan(0.05);
    expect(ratio("gmax1")).toBeGreaterThan(0.01);
    expect(ratio("gmax1")).toBeLessThan(0.05);
  });

  it("folds an absent category's weight budget entirely into normal for that rarity", () => {
    const catalog: TestCard[] = [
      { id: "normal1", rarity: "rare", category: "normal", sortOrder: 1_000_000 },
      { id: "inicial1", rarity: "rare", category: "inicial", sortOrder: 2_000_000 },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "gratis", sequenceRandom(rolls));
    const ratio = (id: string) => picks.filter((c) => c.id === id).length / picks.length;

    expect(ratio("normal1")).toBeGreaterThan(0.93);
    expect(ratio("normal1")).toBeLessThan(0.97);
    expect(ratio("inicial1")).toBeGreaterThan(0.03);
    expect(ratio("inicial1")).toBeLessThan(0.07);
  });

  it("applies shiny within a non-normal category too", () => {
    const catalog: TestCard[] = [
      { id: "mega1", rarity: "epic", category: "mega", sortOrder: 1_000_000 },
      { id: "mega1-shiny", rarity: "epic", category: "mega", sortOrder: 1_000_000 },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "apoyo", sequenceRandom(rolls));
    const shinyRatio = picks.filter((c) => c.id === "mega1-shiny").length / picks.length;
    expect(shinyRatio).toBeGreaterThan(0.005);
    expect(shinyRatio).toBeLessThan(0.015);
  });

  it("exposes the exact per-tier weight tables from the spec", () => {
    expect(RARITY_WEIGHTS_BY_TIER.gratis).toEqual({ common: 71.5, rare: 15, epic: 12, legendary: 1.5 });
    expect(RARITY_WEIGHTS_BY_TIER.apoyo).toEqual({ common: 60, rare: 20, epic: 16, legendary: 4 });
    expect(SHINY_CHANCE_BY_TIER.gratis).toBe(0.005);
    expect(SHINY_CHANCE_BY_TIER.apoyo).toBe(0.01);
  });

  it("gives a multi-form species the same total pull chance as a single-form species", () => {
    const catalog: TestCard[] = [
      { id: "unown-a", rarity: "common", category: "normal", sortOrder: 201_000_000 },
      { id: "unown-b", rarity: "common", category: "normal", sortOrder: 201_000_000 },
      { id: "unown-c", rarity: "common", category: "normal", sortOrder: 201_000_000 },
      { id: "unown-d", rarity: "common", category: "normal", sortOrder: 201_000_000 },
      { id: "unown-e", rarity: "common", category: "normal", sortOrder: 201_000_000 },
      { id: "wobbuffet", rarity: "common", category: "normal", sortOrder: 202_000_000 },
    ];
    const rolls = Array.from({ length: 20000 }, (_, i) => i / 20000);
    const picks = pickRandomCards(catalog, rolls.length, "gratis", sequenceRandom(rolls));
    const unownRatio = picks.filter((c) => c.id.startsWith("unown-")).length / picks.length;
    const wobbuffetRatio = picks.filter((c) => c.id === "wobbuffet").length / picks.length;

    expect(unownRatio).toBeGreaterThan(0.45);
    expect(unownRatio).toBeLessThan(0.55);
    expect(wobbuffetRatio).toBeGreaterThan(0.45);
    expect(wobbuffetRatio).toBeLessThan(0.55);
  });

});
