import { it, expect } from "vitest";
import { classifyRarity } from "./import-pokemon";

it("classifies legendary/mythical regardless of capture rate", () => {
  expect(classifyRarity(45, true, false)).toBe("legendary");
  expect(classifyRarity(3, false, true)).toBe("legendary");
  expect(classifyRarity(255, true, true)).toBe("legendary");
});

it("classifies epic at capture rate 45 and below", () => {
  expect(classifyRarity(45, false, false)).toBe("epic");
  expect(classifyRarity(25, false, false)).toBe("epic");
  expect(classifyRarity(3, false, false)).toBe("epic");
});

it("classifies rare at capture rate 46 to 89", () => {
  expect(classifyRarity(46, false, false)).toBe("rare");
  expect(classifyRarity(75, false, false)).toBe("rare");
  expect(classifyRarity(89, false, false)).toBe("rare");
});

it("classifies common at capture rate 90 and above", () => {
  expect(classifyRarity(90, false, false)).toBe("common");
  expect(classifyRarity(255, false, false)).toBe("common");
});

it("matches known species thresholds from the design spec", () => {
  expect(classifyRarity(90, false, false)).toBe("common"); // Fearow
  expect(classifyRarity(100, false, false)).toBe("common"); // Kadabra
  expect(classifyRarity(75, false, false)).toBe("rare"); // Raichu
  expect(classifyRarity(50, false, false)).toBe("rare"); // Alakazam
  expect(classifyRarity(45, false, false)).toBe("epic"); // Dragonite, Gyarados, Tyranitar
  expect(classifyRarity(25, false, false)).toBe("epic"); // Snorlax
  expect(classifyRarity(3, false, false)).toBe("epic"); // Metagross (no legendary flag)
});
