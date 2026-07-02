import { it, expect } from "vitest";
import { parseCsv, buildCatalog, computeCategory } from "./build-catalog";

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
    { id: "c1", name: "Common Card", rarity: "common", category: "normal", imagePath: "/cards/c1.png", sortOrder: 1 },
    { id: "r1", name: "Rare Card", rarity: "rare", category: "normal", imagePath: "/cards/r1.png", sortOrder: 2 },
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
