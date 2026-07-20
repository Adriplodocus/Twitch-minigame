import { it, expect } from "vitest";
import { renderCardHtml, collectShinyCapableIds } from "./card";
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

it("owned common non-shiny gets no foil/shiny/sparkle, but is tiltable with a glare layer", () => {
  const html = renderCardHtml(card());
  expect(html).not.toMatch(/class="card [^"]*\bfoil\b/);
  expect(html).not.toMatch(/class="card [^"]*\bshiny\b/);
  expect(html).not.toContain('class="sparkle-layer"');
  expect(html).toMatch(/class="card card-rarity-common tiltable/);
  expect(html).toContain('class="glare"');
});

it("owned rare non-shiny gets foil, tiltable, and a glare layer, but no shiny class/sparkles", () => {
  const html = renderCardHtml(card({ rarity: "rare" }));
  expect(html).toMatch(/class="card card-rarity-rare foil tiltable/);
  expect(html).toContain('class="glare"');
  expect(html).not.toContain('class="sparkle-layer"');
});

it("owned common shiny gets foil, shiny, tiltable, glare, and sparkle layer", () => {
  const html = renderCardHtml(card({ name: "Bulbasaur Shiny" }));
  expect(html).toMatch(/class="card card-rarity-common foil shiny tiltable/);
  expect(html).toContain('class="glare"');
  const dotCount = (html.match(/class="dot"/g) ?? []).length;
  expect(dotCount).toBe(7);
});

it("owned legendary shiny gets foil, shiny, tiltable, glare, and sparkle layer", () => {
  const html = renderCardHtml(card({ name: "Mewtwo Shiny", rarity: "legendary" }));
  expect(html).toMatch(/class="card card-rarity-legendary foil shiny tiltable/);
  expect(html).toContain('class="sparkle-layer"');
});

it("unowned rare card gets no foil/tiltable/glare even though rarity qualifies", () => {
  const html = renderCardHtml(card({ rarity: "rare", quantity: 0 }));
  expect(html).not.toMatch(/\bfoil\b/);
  expect(html).not.toMatch(/\btiltable\b/);
  expect(html).not.toContain('class="glare"');
  expect(html).toContain("unowned");
});

it("footerBadgeHtml replaces the auto quantity badge and lands inside the footer, before the info button", () => {
  const html = renderCardHtml(card(), "", undefined, undefined, true, '<span class="mp-have">Tienes 3</span>');
  expect(html).not.toContain("card-qty");
  expect(html).toContain("Tienes 3");
  expect(html.indexOf("Tienes 3")).toBeLessThan(html.indexOf("info-btn"));
});

it("unowned shiny card gets no foil/shiny/sparkle/tiltable either", () => {
  const html = renderCardHtml(card({ name: "Bulbasaur Shiny", quantity: 0 }));
  expect(html).not.toMatch(/class="card [^"]*\bfoil\b/);
  expect(html).not.toMatch(/class="card [^"]*\bshiny\b/);
  expect(html).not.toMatch(/class="card [^"]*\btiltable\b/);
  expect(html).not.toContain('class="sparkle-layer"');
});

it("collectShinyCapableIds returns ids of normal cards that have a -shiny counterpart", () => {
  const cards = [card({ id: "p1" }), card({ id: "p1-shiny" }), card({ id: "p2" })];
  const capable = collectShinyCapableIds(cards);
  expect(capable.has("p1")).toBe(true);
  expect(capable.has("p2")).toBe(false);
  expect(capable.has("p1-shiny")).toBe(false);
});

it("shows no coin action buttons when coinActions is not passed", () => {
  const html = renderCardHtml(card({ quantity: 3 }));
  expect(html).not.toContain("coin-actions");
});

it("shows the discard button with its coin value when quantity > 1", () => {
  const html = renderCardHtml(card({ id: "p1", rarity: "rare", quantity: 3 }), "", undefined, undefined, true, undefined, {
    coins: 0,
    shinyCapableIds: new Set(),
  });
  expect(html).toContain("coin-discard-btn");
  expect(html).toContain("+15"); // DISCARD_VALUE.rare
});

it("hides the discard button when quantity is 1", () => {
  const html = renderCardHtml(card({ id: "p1", quantity: 1 }), "", undefined, undefined, true, undefined, {
    coins: 0,
    shinyCapableIds: new Set(),
  });
  expect(html).not.toContain("coin-discard-btn");
});

it("caps the discard quantity input at copies minus one, carrying the per-unit value", () => {
  const html = renderCardHtml(card({ id: "p1", rarity: "rare", quantity: 6 }), "", undefined, undefined, true, undefined, {
    coins: 0,
    shinyCapableIds: new Set(),
  });
  expect(html).toContain('class="coin-discard-qty" min="1" max="5" value="1" data-unit-value="15"');
});

it("uses the shiny discard value for a shiny card id", () => {
  const html = renderCardHtml(card({ id: "p1-shiny", name: "Bulbasaur Shiny", rarity: "rare", quantity: 3 }), "", undefined, undefined, true, undefined, {
    coins: 0,
    shinyCapableIds: new Set(),
  });
  expect(html).toContain("+120"); // DISCARD_VALUE_SHINY.rare
});

it("shows the convert button, enabled, when eligible and affordable", () => {
  const html = renderCardHtml(card({ id: "p1", rarity: "common", quantity: 2 }), "", undefined, undefined, true, undefined, {
    coins: 150,
    shinyCapableIds: new Set(["p1"]),
  });
  expect(html).toContain("coin-convert-btn");
  expect(html).toContain("150"); // SHINY_CONVERSION_COST.common
  expect(html).not.toMatch(/coin-convert-btn"[^>]*disabled/);
});

it("shows the convert button disabled when coins are insufficient", () => {
  const html = renderCardHtml(card({ id: "p1", rarity: "common", quantity: 2 }), "", undefined, undefined, true, undefined, {
    coins: 0,
    shinyCapableIds: new Set(["p1"]),
  });
  expect(html).toMatch(/coin-convert-btn"[^>]*disabled/);
});

it("hides the convert button when quantity is below 2", () => {
  const html = renderCardHtml(card({ id: "p1", quantity: 1 }), "", undefined, undefined, true, undefined, {
    coins: 9999,
    shinyCapableIds: new Set(["p1"]),
  });
  expect(html).not.toContain("coin-convert-btn");
});

it("hides the convert button when the card has no shiny counterpart", () => {
  const html = renderCardHtml(card({ id: "p1", quantity: 2 }), "", undefined, undefined, true, undefined, {
    coins: 9999,
    shinyCapableIds: new Set(), // p1 not in the set
  });
  expect(html).not.toContain("coin-convert-btn");
});

it("hides the convert button on a card that is already shiny", () => {
  const html = renderCardHtml(card({ id: "p1-shiny", name: "Bulbasaur Shiny", quantity: 2 }), "", undefined, undefined, true, undefined, {
    coins: 9999,
    shinyCapableIds: new Set(["p1-shiny"]), // even if (incorrectly) present, shiny cards never show convert
  });
  expect(html).not.toContain("coin-convert-btn");
});

it("hides both coin action buttons for an unowned card", () => {
  const html = renderCardHtml(card({ id: "p1", quantity: 0 }), "", undefined, undefined, true, undefined, {
    coins: 9999,
    shinyCapableIds: new Set(["p1"]),
  });
  expect(html).not.toContain("coin-actions");
});
