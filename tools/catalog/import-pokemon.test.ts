import { it, expect } from "vitest";
import { classifyRarity } from "./import-pokemon";

it("classifies legendary/mythical regardless of capture rate or BST", () => {
  expect(classifyRarity(45, true, false, 0)).toBe("legendary");
  expect(classifyRarity(3, false, true, 0)).toBe("legendary");
  expect(classifyRarity(255, true, true, 600)).toBe("legendary");
});

it("classifies epic at capture rate below 45, regardless of BST", () => {
  expect(classifyRarity(25, false, false, 100)).toBe("epic");
  expect(classifyRarity(3, false, false, 50)).toBe("epic");
  expect(classifyRarity(30, false, false, 0)).toBe("epic");
});

it("at capture rate exactly 45, epic requires BST >= 490", () => {
  expect(classifyRarity(45, false, false, 490)).toBe("epic");
  expect(classifyRarity(45, false, false, 600)).toBe("epic");
});

it("at capture rate exactly 45, BST below 490 falls to rare", () => {
  expect(classifyRarity(45, false, false, 489)).toBe("rare");
  expect(classifyRarity(45, false, false, 385)).toBe("rare");
});

it("classifies rare at capture rate 46 to 89, regardless of BST", () => {
  expect(classifyRarity(46, false, false, 0)).toBe("rare");
  expect(classifyRarity(75, false, false, 300)).toBe("rare");
  expect(classifyRarity(89, false, false, 600)).toBe("rare");
});

it("classifies common at capture rate 90 and above, regardless of BST", () => {
  expect(classifyRarity(90, false, false, 0)).toBe("common");
  expect(classifyRarity(255, false, false, 600)).toBe("common");
});

it("matches known species thresholds from the design spec", () => {
  expect(classifyRarity(90, false, false, 442)).toBe("common"); // Fearow
  expect(classifyRarity(100, false, false, 400)).toBe("common"); // Kadabra
  expect(classifyRarity(75, false, false, 485)).toBe("rare"); // Raichu
  expect(classifyRarity(50, false, false, 500)).toBe("rare"); // Alakazam
  expect(classifyRarity(25, false, false, 540)).toBe("epic"); // Snorlax
  expect(classifyRarity(3, false, false, 600)).toBe("epic"); // Metagross (no legendary flag)
});

it("separates the capture_rate=45 cluster by BST: notable species stay epic", () => {
  expect(classifyRarity(45, false, false, 600)).toBe("epic"); // Dragonite
  expect(classifyRarity(45, false, false, 540)).toBe("epic"); // Gyarados
  expect(classifyRarity(45, false, false, 490)).toBe("epic"); // Kangaskhan (boundary)
  expect(classifyRarity(45, false, false, 495)).toBe("epic"); // Omastar/Kabutops (fossils)
  expect(classifyRarity(45, false, false, 525)).toBe("epic"); // Venusaur (starter final)
});

it("separates the capture_rate=45 cluster by BST: ordinary species drop to rare", () => {
  expect(classifyRarity(45, false, false, 385)).toBe("rare"); // Onix
  expect(classifyRarity(45, false, false, 470)).toBe("rare"); // Dodrio
  expect(classifyRarity(45, false, false, 395)).toBe("rare"); // Beedrill
  expect(classifyRarity(45, false, false, 318)).toBe("rare"); // Bulbasaur (starter, first stage)
});
