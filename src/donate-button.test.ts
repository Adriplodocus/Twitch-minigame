import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const PAGES = ["collection.html", "trade.html", "offers.html", "album.html"];

describe("donate button", () => {
  for (const page of PAGES) {
    it(`is present with the correct href in ${page}`, () => {
      const html = readFileSync(page, "utf-8");
      expect(html).toContain('class="donate-btn"');
      expect(html).toContain('href="https://www.paypal.com/paypalme/MrKlypp"');
      expect(html).toContain('target="_blank"');
    });
  }

  it("is not present in admin.html", () => {
    const html = readFileSync("admin.html", "utf-8");
    expect(html).not.toMatch(/donate-btn/);
  });
});
