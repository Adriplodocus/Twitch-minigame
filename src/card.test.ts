import { it, expect } from "vitest";
import { renderCardHtml } from "./card";
import type { CardView } from "./api";

function card(overrides: Partial<CardView> = {}): CardView {
  return {
    id: "p1",
    name: "Bulbasaur",
    rarity: "common",
    imagePath: "/p1.png",
    quantity: 1,
    generation: 1,
    ...overrides,
  };
}

it("owned common non-shiny gets no foil, no shiny, no overlay markup", () => {
  const html = renderCardHtml(card());
  expect(html).not.toMatch(/class="card [^"]*\bfoil\b/);
  expect(html).not.toContain('class="glare"');
  expect(html).not.toContain('class="sparkle-layer"');
});

it("owned rare non-shiny gets foil and a glare layer, but no shiny class/sparkles", () => {
  const html = renderCardHtml(card({ rarity: "rare" }));
  expect(html).toMatch(/class="card card-rarity-rare foil/);
  expect(html).toContain('class="glare"');
  expect(html).not.toContain('class="sparkle-layer"');
});

it("owned common shiny gets foil, shiny, glare, and sparkle layer", () => {
  const html = renderCardHtml(card({ name: "Bulbasaur Shiny" }));
  expect(html).toMatch(/class="card card-rarity-common foil shiny/);
  expect(html).toContain('class="glare"');
  const dotCount = (html.match(/class="dot"/g) ?? []).length;
  expect(dotCount).toBe(6);
});

it("owned legendary shiny gets foil, shiny, glare, and sparkle layer", () => {
  const html = renderCardHtml(card({ name: "Mewtwo Shiny", rarity: "legendary" }));
  expect(html).toMatch(/class="card card-rarity-legendary foil shiny/);
  expect(html).toContain('class="sparkle-layer"');
});

it("unowned rare card gets no foil even though rarity qualifies", () => {
  const html = renderCardHtml(card({ rarity: "rare", quantity: 0 }));
  expect(html).not.toMatch(/\bfoil\b/);
  expect(html).toContain("unowned");
});

it("unowned shiny card gets no foil/shiny/sparkle either", () => {
  const html = renderCardHtml(card({ name: "Bulbasaur Shiny", quantity: 0 }));
  expect(html).not.toMatch(/class="card [^"]*\bfoil\b/);
  expect(html).not.toMatch(/class="card [^"]*\bshiny\b/);
  expect(html).not.toContain('class="sparkle-layer"');
});
