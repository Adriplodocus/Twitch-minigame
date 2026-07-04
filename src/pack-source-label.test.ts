import { it, expect } from "vitest";
import { sourceLabel } from "./pack-source-label";

it("maps known pack sources to Spanish labels", () => {
  expect(sourceLabel("reward")).toBe("Recompensa");
  expect(sourceLabel("admin")).toBe("Admin");
  expect(sourceLabel("bits")).toBe("Bits");
  expect(sourceLabel("sub")).toBe("Suscripción");
  expect(sourceLabel("gift_sub")).toBe("Regalo sub");
});

it("falls back to the raw value for an unknown source", () => {
  expect(sourceLabel("unknown_source")).toBe("unknown_source");
});
