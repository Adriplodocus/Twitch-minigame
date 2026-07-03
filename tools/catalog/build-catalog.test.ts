import { it, expect } from "vitest";
import { parseCsv, buildCatalog, computeCategory, computeGeneration, computeRarityFloor } from "./build-catalog";

it("parses CSV rows", () => {
  const csv = "id,name,rarity,image_filename\nc1,Common Card,common,c1.png\nr1,Rare Card,rare,r1.png\n";
  const rows = parseCsv(csv);
  expect(rows).toEqual([
    { id: "c1", name: "Common Card", rarity: "common", imageFilename: "c1.png" },
    { id: "r1", name: "Rare Card", rarity: "rare", imageFilename: "r1.png" },
  ]);
});

it("throws on an unknown rarity", () => {
  const csv = "id,name,rarity,image_filename\nc1,Common Card,mythic,c1.png\n";
  expect(() => parseCsv(csv)).toThrow(/rarity/i);
});

it("builds a catalog and seed SQL from valid rows", () => {
  const rows = [
    { id: "c1", name: "Common Card", rarity: "common" as const, imageFilename: "c1.png", sortOrder: 1 },
    { id: "r1", name: "Rare Card", rarity: "rare" as const, imageFilename: "r1.png", sortOrder: 2 },
  ];
  const { catalog, seedSql } = buildCatalog(rows, new Set(["c1.png", "r1.png"]));

  expect(catalog).toEqual([
    {
      id: "c1",
      name: "Common Card",
      rarity: "common",
      category: "normal",
      generation: 1,
      imagePath: "/cards/c1.png",
      sortOrder: 1,
    },
    {
      id: "r1",
      name: "Rare Card",
      rarity: "rare",
      category: "normal",
      generation: 1,
      imagePath: "/cards/r1.png",
      sortOrder: 2,
    },
  ]);
  expect(seedSql).toContain("INSERT OR REPLACE INTO cards");
  expect(seedSql).toContain("'c1'");
  expect(seedSql).toContain("'r1'");
});

it("defaults sortOrder to 0 when omitted", () => {
  const rows = [{ id: "c1", name: "Common Card", rarity: "common" as const, imageFilename: "c1.png" }];
  const { catalog } = buildCatalog(rows, new Set(["c1.png"]));
  expect(catalog[0].sortOrder).toBe(0);
});

it("throws when a referenced image file does not exist", () => {
  const rows = [{ id: "c1", name: "Common Card", rarity: "common" as const, imageFilename: "missing.png" }];
  expect(() => buildCatalog(rows, new Set(["c1.png"]))).toThrow(/missing\.png/);
});

it("throws on duplicate card ids", () => {
  const rows = [
    { id: "c1", name: "Common Card", rarity: "common" as const, imageFilename: "c1.png" },
    { id: "c1", name: "Duplicate", rarity: "rare" as const, imageFilename: "c1.png" },
  ];
  expect(() => buildCatalog(rows, new Set(["c1.png"]))).toThrow(/duplicate/i);
});

it("categorizes starter-line species as inicial", () => {
  expect(computeCategory("Bulbasaur")).toBe("inicial");
  expect(computeCategory("Ivysaur")).toBe("inicial");
  expect(computeCategory("Venusaur")).toBe("inicial");
  expect(computeCategory("Venusaur Shiny")).toBe("inicial");
  expect(computeCategory("Venusaur (Hembra)")).toBe("inicial");
});

it("gives inicial precedence over mega/gmax for starter-line species", () => {
  expect(computeCategory("Venusaur Mega")).toBe("inicial");
  expect(computeCategory("Venusaur Mega (Hembra)")).toBe("inicial");
  expect(computeCategory("Venusaur Gmax")).toBe("inicial");
});

it("categorizes non-starter Mega/Gmax cards correctly", () => {
  expect(computeCategory("Alakazam Mega")).toBe("mega");
  expect(computeCategory("Gengar Mega")).toBe("mega");
  expect(computeCategory("Pikachu Gmax")).toBe("gmax");
  expect(computeCategory("Lapras Gmax")).toBe("gmax");
});

it("gives inicial precedence even for a starter's Mega/Gmax forms not caught by the earlier test (Charizard, a starter final evolution)", () => {
  expect(computeCategory("Charizard Mega X")).toBe("inicial");
  expect(computeCategory("Charizard Mega Y")).toBe("inicial");
});

it("does not false-positive-match Meganium as mega (word boundary), but still categorizes it as inicial", () => {
  expect(computeCategory("Meganium")).toBe("inicial");
  expect(computeCategory("Meganium Shiny")).toBe("inicial");
});

it("categorizes everything else as normal", () => {
  expect(computeCategory("Pidgey")).toBe("normal");
  expect(computeCategory("Mewtwo")).toBe("normal");
  expect(computeCategory("Mewtwo Mega X")).toBe("mega");
});

it("computes generation from dex ranges via sortOrder", () => {
  expect(computeGeneration("Bulbasaur", "normal", 1 * 1_000_000)).toBe(1);
  expect(computeGeneration("Ho-Oh", "normal", 250 * 1_000_000)).toBe(2);
  expect(computeGeneration("Absol", "normal", 359 * 1_000_000)).toBe(3);
  expect(computeGeneration("Arceus", "normal", 493 * 1_000_000)).toBe(4);
  expect(computeGeneration("Reshiram", "normal", 643 * 1_000_000)).toBe(5);
  expect(computeGeneration("Xerneas", "normal", 716 * 1_000_000)).toBe(6);
  expect(computeGeneration("Solgaleo", "normal", 791 * 1_000_000)).toBe(7);
  expect(computeGeneration("Zacian", "normal", 888 * 1_000_000)).toBe(8);
  expect(computeGeneration("Koraidon", "normal", 1007 * 1_000_000)).toBe(9);
});

it("handles dex range boundaries", () => {
  expect(computeGeneration("X", "normal", 151 * 1_000_000)).toBe(1);
  expect(computeGeneration("X", "normal", 152 * 1_000_000)).toBe(2);
  expect(computeGeneration("X", "normal", 386 * 1_000_000)).toBe(3);
  expect(computeGeneration("X", "normal", 387 * 1_000_000)).toBe(4);
  expect(computeGeneration("X", "normal", 905 * 1_000_000)).toBe(8);
  expect(computeGeneration("X", "normal", 906 * 1_000_000)).toBe(9);
});

it("overrides generation for mega and gmax categories regardless of base dex", () => {
  expect(computeGeneration("Charizard Mega X", "mega", 6 * 1_000_000)).toBe(6);
  expect(computeGeneration("Pikachu Gmax", "gmax", 25 * 1_000_000)).toBe(8);
});

it("overrides generation for a starter species' Mega/Gmax forms even though computeCategory reports them as 'inicial'", () => {
  // Regression test: computeCategory gives "inicial" precedence over "mega"/"gmax" for
  // starter-line species (see the "gives inicial precedence..." tests above), so
  // computeGeneration must not rely on that collapsed category to detect Mega/Gmax cards.
  expect(computeCategory("Venusaur Mega")).toBe("inicial");
  expect(computeGeneration("Venusaur Mega", computeCategory("Venusaur Mega"), 3 * 1_000_000)).toBe(6);

  expect(computeCategory("Charizard Mega X")).toBe("inicial");
  expect(computeGeneration("Charizard Mega X", computeCategory("Charizard Mega X"), 6 * 1_000_000)).toBe(6);

  expect(computeCategory("Venusaur Gmax")).toBe("inicial");
  expect(computeGeneration("Venusaur Gmax", computeCategory("Venusaur Gmax"), 3 * 1_000_000)).toBe(8);
});

it("overrides generation for regional-form names regardless of base dex", () => {
  expect(computeGeneration("Vulpix Alola", "normal", 37 * 1_000_000)).toBe(7);
  expect(computeGeneration("Meowth Galar", "normal", 52 * 1_000_000)).toBe(8);
  expect(computeGeneration("Typhlosion Hisui", "normal", 157 * 1_000_000)).toBe(8);
  expect(computeGeneration("Wooper Paldea", "normal", 194 * 1_000_000)).toBe(9);
});

it("floors mega/gmax cards to at least rare", () => {
  expect(computeRarityFloor("Meowth Gmax", "gmax", "common")).toBe("rare");
  expect(computeRarityFloor("Gengar Mega", "mega", "common")).toBe("rare");
});

it("does not lower a mega/gmax card that is already above the rare floor", () => {
  expect(computeRarityFloor("Gengar Mega", "mega", "epic")).toBe("epic");
  expect(computeRarityFloor("Gengar Mega", "mega", "legendary")).toBe("legendary");
});

it("does not floor normal-category cards", () => {
  expect(computeRarityFloor("Meowth", "normal", "common")).toBe("common");
});

it("floors named legendary-tier Ultra Beasts and Paradox species to legendary", () => {
  expect(computeRarityFloor("Nihilego", "normal", "common")).toBe("legendary");
  expect(computeRarityFloor("Buzzwole", "normal", "rare")).toBe("legendary");
  expect(computeRarityFloor("Walking Wake", "normal", "epic")).toBe("legendary");
  expect(computeRarityFloor("Raging Bolt", "normal", "common")).toBe("legendary");
});

it("floors named epic-tier Paradox species to epic", () => {
  expect(computeRarityFloor("Great Tusk", "normal", "common")).toBe("epic");
  expect(computeRarityFloor("Iron Valiant", "normal", "rare")).toBe("epic");
});

it("matches named-species floors on shiny/female name suffixes via word-boundary prefix", () => {
  expect(computeRarityFloor("Nihilego Shiny", "normal", "common")).toBe("legendary");
  expect(computeRarityFloor("Great Tusk Shiny", "normal", "common")).toBe("epic");
});

it("does not lower a named-species card that is already above its floor", () => {
  expect(computeRarityFloor("Nihilego", "normal", "legendary")).toBe("legendary");
  expect(computeRarityFloor("Great Tusk", "normal", "legendary")).toBe("legendary");
});
