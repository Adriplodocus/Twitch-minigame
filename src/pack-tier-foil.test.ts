import { it, expect } from "vitest";
import { shouldShowFoil } from "./pack-tier-foil";

it("shows foil for apoyo packs", () => {
  expect(shouldShowFoil("apoyo")).toBe(true);
});

it("does not show foil for gratis packs", () => {
  expect(shouldShowFoil("gratis")).toBe(false);
});
