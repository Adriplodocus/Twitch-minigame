import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Rarity = "common" | "rare" | "epic" | "legendary";
const VALID_RARITIES: Rarity[] = ["common", "rare", "epic", "legendary"];

export interface CardRow {
  id: string;
  name: string;
  rarity: Rarity;
  imageFilename: string;
  sortOrder?: number;
}

export interface CatalogEntry {
  id: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
  sortOrder: number;
}

export function parseCsv(content: string): CardRow[] {
  const lines = content.trim().split("\n").filter((line) => line.length > 0);
  const [, ...dataLines] = lines;
  return dataLines.map((line) => {
    const [id, name, rarity, imageFilename, sortOrder] = line.split(",").map((field) => field.trim());
    if (!VALID_RARITIES.includes(rarity as Rarity)) {
      throw new Error(`Invalid rarity "${rarity}" for card "${id}". Must be one of: ${VALID_RARITIES.join(", ")}`);
    }
    return {
      id,
      name,
      rarity: rarity as Rarity,
      imageFilename,
      ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) } : {}),
    };
  });
}

export function buildCatalog(
  rows: CardRow[],
  existingImageFiles: Set<string>
): { catalog: CatalogEntry[]; seedSql: string } {
  const seenIds = new Set<string>();
  const catalog: CatalogEntry[] = [];

  for (const row of rows) {
    if (seenIds.has(row.id)) throw new Error(`Duplicate card id: ${row.id}`);
    seenIds.add(row.id);

    if (!existingImageFiles.has(row.imageFilename)) {
      throw new Error(`Image file not found in public/cards/: ${row.imageFilename}`);
    }

    catalog.push({
      id: row.id,
      name: row.name,
      rarity: row.rarity,
      imagePath: `/cards/${row.imageFilename}`,
      sortOrder: row.sortOrder ?? 0,
    });
  }

  const CHUNK_SIZE = 200;
  const statements: string[] = [];
  for (let i = 0; i < catalog.length; i += CHUNK_SIZE) {
    const chunk = catalog.slice(i, i + CHUNK_SIZE);
    const values = chunk
      .map(
        (card) =>
          `('${card.id}', '${card.name.replace(/'/g, "''")}', '${card.rarity}', '${card.imagePath}', ${card.sortOrder})`
      )
      .join(",\n  ");
    statements.push(
      `INSERT OR REPLACE INTO cards (id, name, rarity, image_path, sort_order) VALUES\n  ${values};`
    );
  }
  const seedSql = statements.join("\n") + "\n";

  return { catalog, seedSql };
}

function main(): void {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const csvPath = path.join(__dirname, "cards.csv");
  const imagesDir = path.join(__dirname, "..", "..", "public", "cards");
  const catalogOutPath = path.join(__dirname, "..", "..", "catalog.json");
  const seedOutPath = path.join(__dirname, "seed-cards.sql");

  const csvContent = readFileSync(csvPath, "utf-8");
  const rows = parseCsv(csvContent);

  const existingImageFiles = new Set(existsSync(imagesDir) ? readdirSync(imagesDir) : []);
  const { catalog, seedSql } = buildCatalog(rows, existingImageFiles);

  writeFileSync(catalogOutPath, JSON.stringify(catalog, null, 2));
  writeFileSync(seedOutPath, seedSql);

  console.log(`Wrote ${catalog.length} cards to ${catalogOutPath} and ${seedOutPath}`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
