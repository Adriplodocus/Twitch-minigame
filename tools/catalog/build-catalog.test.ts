import { it, expect } from "vitest";
import { parseCsv, buildCatalog } from "./build-catalog";

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
    { id: "c1", name: "Common Card", rarity: "common" as const, imageFilename: "c1.png" },
    { id: "r1", name: "Rare Card", rarity: "rare" as const, imageFilename: "r1.png" },
  ];
  const { catalog, seedSql } = buildCatalog(rows, new Set(["c1.png", "r1.png"]));

  expect(catalog).toEqual([
    { id: "c1", name: "Common Card", rarity: "common", imagePath: "/cards/c1.png" },
    { id: "r1", name: "Rare Card", rarity: "rare", imagePath: "/cards/r1.png" },
  ]);
  expect(seedSql).toContain("INSERT OR REPLACE INTO cards");
  expect(seedSql).toContain("'c1'");
  expect(seedSql).toContain("'r1'");
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
