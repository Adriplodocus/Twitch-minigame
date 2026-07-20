import { it, expect } from "vitest";
import { pickRandomCards, pickExactCards, RARITY_WEIGHTS_BY_TIER } from "../../worker/lib/packs";

const catalog = [
  { id: "c1", rarity: "common" as const, category: "normal" as const, sortOrder: 1_000_000 },
  { id: "r1", rarity: "rare" as const, category: "normal" as const, sortOrder: 2_000_000 },
  { id: "e1", rarity: "epic" as const, category: "normal" as const, sortOrder: 3_000_000 },
  { id: "l1", rarity: "legendary" as const, category: "normal" as const, sortOrder: 4_000_000 },
];

const shinyCatalog = [
  { id: "c1", rarity: "common" as const },
  { id: "c1-shiny", rarity: "common" as const },
  { id: "l1", rarity: "legendary" as const },
  { id: "l1-shiny", rarity: "legendary" as const },
];

it("returns the requested number of cards", () => {
  const picks = pickRandomCards(catalog, 5, "gratis", () => 0.5);
  expect(picks).toHaveLength(5);
});

it("picks the first card when random() returns 0", () => {
  const picks = pickRandomCards(catalog, 1, "gratis", () => 0);
  expect(picks[0].id).toBe("c1");
});

it("picks the last card when random() returns just under 1", () => {
  const picks = pickRandomCards(catalog, 1, "gratis", () => 0.999999);
  expect(picks[0].id).toBe("l1");
});

it("throws on an empty catalog", () => {
  expect(() => pickRandomCards([], 5, "gratis")).toThrow();
});

it("pickExactCards returns exactly the requested count per rarity", () => {
  const picks = pickExactCards(shinyCatalog, { common: 2, rare: 0, epic: 0, legendary: 1, shiny: 0 });
  expect(picks.filter((c) => c.rarity === "common")).toHaveLength(2);
  expect(picks.filter((c) => c.rarity === "legendary")).toHaveLength(1);
  expect(picks.every((c) => !c.id.includes("-shiny"))).toBe(true);
});

it("pickExactCards picks shiny cards from any rarity", () => {
  const picks = pickExactCards(shinyCatalog, { common: 0, rare: 0, epic: 0, legendary: 0, shiny: 3 }, () => 0.99);
  expect(picks).toHaveLength(3);
  expect(picks.every((c) => c.id.includes("-shiny"))).toBe(true);
});

it("pickExactCards throws when a requested rarity has no non-shiny cards", () => {
  expect(() =>
    pickExactCards([{ id: "r1-shiny", rarity: "rare" as const }], {
      common: 0,
      rare: 1,
      epic: 0,
      legendary: 0,
      shiny: 0,
    })
  ).toThrow();
});

it("pickExactCards throws when shiny is requested but none exist", () => {
  expect(() =>
    pickExactCards([{ id: "c1", rarity: "common" as const }], {
      common: 0,
      rare: 0,
      epic: 0,
      legendary: 0,
      shiny: 1,
    })
  ).toThrow();
});

it("defines descending weights per rarity within each tier", () => {
  for (const tier of ["gratis", "apoyo"] as const) {
    const weights = RARITY_WEIGHTS_BY_TIER[tier];
    expect(weights.common).toBeGreaterThan(weights.rare);
    expect(weights.rare).toBeGreaterThan(weights.epic);
    expect(weights.epic).toBeGreaterThan(weights.legendary);
  }
});
