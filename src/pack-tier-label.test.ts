import { it, expect } from "vitest";
import { tierLabel } from "./pack-tier-label";

it("maps known pack tiers to Spanish labels", () => {
  expect(tierLabel("gratis")).toBe("Gratis");
  expect(tierLabel("apoyo")).toBe("Premium");
});

it("falls back to the raw value for an unknown tier", () => {
  expect(tierLabel("unknown_tier")).toBe("unknown_tier");
});
