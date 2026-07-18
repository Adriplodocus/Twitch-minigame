// src/daily-pack-button.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("daily pack button", () => {
  it.each(["collection.html", "trade.html", "offers.html", "album.html"])("is present in %s", (file) => {
    const html = readFileSync(resolve(__dirname, "..", file), "utf-8");
    expect(html).toContain('id="daily-pack-btn"');
  });

  it("is absent from admin.html", () => {
    const html = readFileSync(resolve(__dirname, "..", "admin.html"), "utf-8");
    expect(html).not.toContain("daily-pack-btn");
  });
});

