import { it, expect } from "vitest";
import { pickRandomCards, RARITY_WEIGHTS } from "../../worker/lib/packs";

const catalog = [
  { id: "c1", rarity: "common" as const, category: "normal" as const },
  { id: "r1", rarity: "rare" as const, category: "normal" as const },
  { id: "e1", rarity: "epic" as const, category: "normal" as const },
  { id: "l1", rarity: "legendary" as const, category: "normal" as const },
];

it("returns the requested number of cards", () => {
  const picks = pickRandomCards(catalog, 5, () => 0.5);
  expect(picks).toHaveLength(5);
});

it("picks the first card when random() returns 0", () => {
  const picks = pickRandomCards(catalog, 1, () => 0);
  expect(picks[0].id).toBe("c1");
});

it("picks the last card when random() returns just under 1", () => {
  const picks = pickRandomCards(catalog, 1, () => 0.999999);
  expect(picks[0].id).toBe("l1");
});

it("throws on an empty catalog", () => {
  expect(() => pickRandomCards([], 5)).toThrow();
});

it("defines descending weights per rarity tier", () => {
  expect(RARITY_WEIGHTS.common).toBeGreaterThan(RARITY_WEIGHTS.rare);
  expect(RARITY_WEIGHTS.rare).toBeGreaterThan(RARITY_WEIGHTS.epic);
  expect(RARITY_WEIGHTS.epic).toBeGreaterThan(RARITY_WEIGHTS.legendary);
});
