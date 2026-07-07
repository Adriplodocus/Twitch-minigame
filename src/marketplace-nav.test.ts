import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("marketplace nav link", () => {
  it.each(["collection.html", "trade.html", "album.html", "offers.html"])("is present in %s", (file) => {
    const html = readFileSync(resolve(__dirname, "..", file), "utf-8");
    expect(html).toContain('href="/marketplace.html"');
  });
});
