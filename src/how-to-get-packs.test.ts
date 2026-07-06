import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const PAGES = ["collection.html", "trade.html", "offers.html", "album.html"];

describe("how-to-get-packs popover", () => {
  for (const page of PAGES) {
    it(`is present in ${page}`, () => {
      const html = readFileSync(page, "utf-8");
      expect(html).toContain('id="how-to-btn"');
      expect(html).toContain('id="how-to-panel"');
      expect(html).toContain("¿Cómo conseguir sobres?");
    });
  }

  it("is not present in admin.html", () => {
    const html = readFileSync("admin.html", "utf-8");
    expect(html).not.toMatch(/how-to-btn/);
  });
});
