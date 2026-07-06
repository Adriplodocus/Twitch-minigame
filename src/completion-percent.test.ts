import { it, expect } from "vitest";
import { completionPercent } from "./completion-percent";

it("returns 0 when owning nothing", () => {
  expect(completionPercent(0, 151)).toBe(0);
});

it("returns 0 when there are no cards", () => {
  expect(completionPercent(0, 0)).toBe(0);
});

it("returns 100 only when owning everything", () => {
  expect(completionPercent(151, 151)).toBe(100);
});

it("clamps low ratios up to 1%", () => {
  expect(completionPercent(1, 1000)).toBe(1);
});

it("clamps near-complete ratios down to 99%", () => {
  expect(completionPercent(150, 151)).toBe(99);
});

it("rounds normally in the middle range", () => {
  expect(completionPercent(76, 151)).toBe(50);
});
