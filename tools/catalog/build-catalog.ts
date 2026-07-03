import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Rarity = "common" | "rare" | "epic" | "legendary";
const VALID_RARITIES: Rarity[] = ["common", "rare", "epic", "legendary"];

export type Category = "normal" | "inicial" | "mega" | "gmax";

const STARTER_SPECIES = [
  "Bulbasaur", "Ivysaur", "Venusaur", "Charmander", "Charmeleon", "Charizard", "Squirtle", "Wartortle", "Blastoise",
  "Chikorita", "Bayleef", "Meganium", "Cyndaquil", "Quilava", "Typhlosion", "Totodile", "Croconaw", "Feraligatr",
  "Treecko", "Grovyle", "Sceptile", "Torchic", "Combusken", "Blaziken", "Mudkip", "Marshtomp", "Swampert",
  "Turtwig", "Grotle", "Torterra", "Chimchar", "Monferno", "Infernape", "Piplup", "Prinplup", "Empoleon",
  "Snivy", "Servine", "Serperior", "Tepig", "Pignite", "Emboar", "Oshawott", "Dewott", "Samurott",
  "Chespin", "Quilladin", "Chesnaught", "Fennekin", "Braixen", "Delphox", "Froakie", "Frogadier", "Greninja",
  "Rowlet", "Dartrix", "Decidueye", "Litten", "Torracat", "Incineroar", "Popplio", "Brionne", "Primarina",
  "Grookey", "Thwackey", "Rillaboom", "Scorbunny", "Raboot", "Cinderace", "Sobble", "Drizzile", "Inteleon",
  "Sprigatito", "Floragato", "Meowscarada", "Fuecoco", "Crocalor", "Skeledirge", "Quaxly", "Quaxwell", "Quaquaval",
];

const STARTER_PREFIX_RE = new RegExp(`^(${STARTER_SPECIES.join("|")})\\b`);
const MEGA_RE = /\bMega\b/;
const GMAX_RE = /\bGmax\b/;

export function computeCategory(name: string): Category {
  if (STARTER_PREFIX_RE.test(name)) return "inicial";
  if (MEGA_RE.test(name)) return "mega";
  if (GMAX_RE.test(name)) return "gmax";
  return "normal";
}

const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };

function floorRarity(rarity: Rarity, floor: Rarity): Rarity {
  return RARITY_RANK[floor] > RARITY_RANK[rarity] ? floor : rarity;
}

const LEGENDARY_FLOOR_SPECIES = [
  "Nihilego", "Buzzwole", "Pheromosa", "Xurkitree", "Celesteela", "Kartana", "Guzzlord",
  "Poipole", "Naganadel", "Stakataka", "Blacephalon",
  "Walking Wake", "Iron Leaves", "Gouging Fire", "Raging Bolt", "Iron Boulder", "Iron Crown",
];

const EPIC_FLOOR_SPECIES = [
  "Great Tusk", "Scream Tail", "Brute Bonnet", "Flutter Mane", "Slither Wing", "Sandy Shocks",
  "Iron Treads", "Iron Bundle", "Iron Hands", "Iron Jugulis", "Iron Moth", "Iron Thorns",
  "Roaring Moon", "Iron Valiant",
];

const LEGENDARY_FLOOR_RE = new RegExp(`^(${LEGENDARY_FLOOR_SPECIES.join("|")})\\b`);
const EPIC_FLOOR_RE = new RegExp(`^(${EPIC_FLOOR_SPECIES.join("|")})\\b`);

export function computeRarityFloor(name: string, category: Category, rarity: Rarity): Rarity {
  let floored = rarity;
  // Keyed off `category`, not the Mega/Gmax name regex, so a starter-line Mega/Gmax
  // (category collapses to "inicial", see computeCategory) skips this floor. Currently
  // safe: every starter final evolution has capture_rate 45 and base_stat_total >= 490,
  // so classifyRarity already puts it at epic (>= rare) on its own.
  if (category === "mega" || category === "gmax") floored = floorRarity(floored, "rare");
  if (LEGENDARY_FLOOR_RE.test(name)) floored = floorRarity(floored, "legendary");
  else if (EPIC_FLOOR_RE.test(name)) floored = floorRarity(floored, "epic");
  return floored;
}

const REGIONAL_GENERATION_OVERRIDES: { pattern: RegExp; generation: number }[] = [
  { pattern: /\bAlola\b/, generation: 7 },
  { pattern: /\bGalar\b/, generation: 8 },
  { pattern: /\bHisui\b/, generation: 8 },
  { pattern: /\bPaldea\b/, generation: 9 },
];

const DEX_GENERATION_RANGES: { max: number; generation: number }[] = [
  { max: 151, generation: 1 },
  { max: 251, generation: 2 },
  { max: 386, generation: 3 },
  { max: 493, generation: 4 },
  { max: 649, generation: 5 },
  { max: 721, generation: 6 },
  { max: 809, generation: 7 },
  { max: 905, generation: 8 },
  { max: 1025, generation: 9 },
];

function generationFromDex(dexNumber: number): number {
  for (const range of DEX_GENERATION_RANGES) {
    if (dexNumber <= range.max) return range.generation;
  }
  return 9;
}

export function computeGeneration(name: string, category: Category, sortOrder: number): number {
  // Note: deliberately test the name patterns directly rather than branching on `category`.
  // `category` collapses to "inicial" for a starter species' Mega/Gmax forms (e.g. "Charizard
  // Mega X", "Venusaur Gmax") — that precedence is intentional for pack drop-rate weighting
  // (see computeCategory), but generation classification still needs to recognize these as
  // Mega/Gmax regardless of which category bucket they landed in.
  if (MEGA_RE.test(name)) return 6;
  if (GMAX_RE.test(name)) return 8;
  for (const override of REGIONAL_GENERATION_OVERRIDES) {
    if (override.pattern.test(name)) return override.generation;
  }
  return generationFromDex(Math.floor(sortOrder / 1_000_000));
}

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
  category: Category;
  generation: number;
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

    const category = computeCategory(row.name);
    const sortOrder = row.sortOrder ?? 0;
    const rarity = computeRarityFloor(row.name, category, row.rarity);
    catalog.push({
      id: row.id,
      name: row.name,
      rarity,
      category,
      generation: computeGeneration(row.name, category, sortOrder),
      imagePath: `/cards/${row.imageFilename}`,
      sortOrder,
    });
  }

  const CHUNK_SIZE = 200;
  const statements: string[] = [];
  for (let i = 0; i < catalog.length; i += CHUNK_SIZE) {
    const chunk = catalog.slice(i, i + CHUNK_SIZE);
    const values = chunk
      .map(
        (card) =>
          `('${card.id}', '${card.name.replace(/'/g, "''")}', '${card.rarity}', '${card.category}', ${card.generation}, '${card.imagePath}', ${card.sortOrder})`
      )
      .join(",\n  ");
    statements.push(
      `INSERT OR REPLACE INTO cards (id, name, rarity, category, generation, image_path, sort_order) VALUES\n  ${values};`
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
