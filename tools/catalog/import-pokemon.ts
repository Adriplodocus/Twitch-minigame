import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SPRITE_ROOT = process.env.SPRITE_ROOT ?? "C:/Proyectos/SpritesPokemon/sprites/pokemon";
const CARDS_OUT_DIR = path.join(__dirname, "..", "..", "public", "cards");
const CSV_OUT_PATH = path.join(__dirname, "cards.csv");
const CACHE_PATH = path.join(__dirname, ".pokeapi-cache.json");

const NON_POKEMON_FILES = new Set(["egg.png", "egg-manaphy.png", "substitute.png"]);

type Rarity = "common" | "rare" | "epic" | "legendary";

interface SpriteEntry {
  id: number;
  suffix: string | null;
  filename: string;
}

interface SpeciesInfo {
  name: string;
  dexNumber: number;
  isLegendary: boolean;
  isMythical: boolean;
  evolvesFrom: string | null;
}

interface Cache {
  pokemonNameById: Record<string, { name: string; speciesName: string }>;
  species: Record<string, SpeciesInfo>;
}

function loadCache(): Cache {
  if (existsSync(CACHE_PATH)) {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  }
  return { pokemonNameById: {}, species: {} };
}

function saveCache(cache: Cache): void {
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

async function fetchJson(url: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`Failed to fetch ${url}`);
}

async function getPokemon(cache: Cache, id: number): Promise<{ name: string; speciesName: string } | null> {
  const key = String(id);
  if (cache.pokemonNameById[key]) return cache.pokemonNameById[key];
  const data = await fetchJson(`https://pokeapi.co/api/v2/pokemon/${id}`);
  if (!data) return null;
  const entry = { name: data.name as string, speciesName: data.species.name as string };
  cache.pokemonNameById[key] = entry;
  return entry;
}

async function getSpecies(cache: Cache, speciesName: string): Promise<SpeciesInfo> {
  if (cache.species[speciesName]) return cache.species[speciesName];
  const data = await fetchJson(`https://pokeapi.co/api/v2/pokemon-species/${speciesName}`);
  const info: SpeciesInfo = {
    name: speciesName,
    dexNumber: data?.id ?? 0,
    isLegendary: !!data?.is_legendary,
    isMythical: !!data?.is_mythical,
    evolvesFrom: data?.evolves_from_species?.name ?? null,
  };
  cache.species[speciesName] = info;
  return info;
}

async function getRarity(cache: Cache, speciesName: string): Promise<Rarity> {
  const species = await getSpecies(cache, speciesName);
  if (species.isLegendary || species.isMythical) return "legendary";
  if (species.evolvesFrom) {
    const parent = await getSpecies(cache, species.evolvesFrom);
    if (parent.evolvesFrom) return "epic";
    return "rare";
  }
  return "common";
}

function titleCase(name: string): string {
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function humanizeSuffix(speciesName: string, suffix: string): string {
  if (speciesName === "unown") {
    if (suffix.length === 1) return suffix.toUpperCase();
    if (suffix === "exclamation") return "!";
    if (suffix === "question") return "?";
  }
  return titleCase(suffix);
}

function listSpriteEntries(dir: string): SpriteEntry[] {
  if (!existsSync(dir)) return [];
  const entries: SpriteEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (NON_POKEMON_FILES.has(f)) continue;
    const plainMatch = f.match(/^([0-9]+)\.png$/);
    if (plainMatch) {
      const id = Number(plainMatch[1]);
      if (id !== 0) entries.push({ id, suffix: null, filename: f });
      continue;
    }
    const suffixMatch = f.match(/^([0-9]+)-(.+)\.png$/);
    if (suffixMatch) {
      entries.push({ id: Number(suffixMatch[1]), suffix: suffixMatch[2], filename: f });
    }
  }
  return entries;
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

interface CardRow {
  id: string;
  name: string;
  rarity: Rarity;
  imageFilename: string;
  sourcePath: string;
  sortOrder: number;
}

function slugSuffix(variantSuffix: string): string {
  return variantSuffix.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

async function main(): Promise<void> {
  const groups: {
    key: string;
    dir: string;
    nameSuffix: (n: string) => string;
    idSuffix: string;
    variantRank: number;
  }[] = [
    { key: "base", dir: SPRITE_ROOT, nameSuffix: (n) => n, idSuffix: "", variantRank: 0 },
    {
      key: "female",
      dir: path.join(SPRITE_ROOT, "female"),
      nameSuffix: (n) => `${n} (Hembra)`,
      idSuffix: "-female",
      variantRank: 1,
    },
    {
      key: "shiny",
      dir: path.join(SPRITE_ROOT, "shiny"),
      nameSuffix: (n) => `${n} Shiny`,
      idSuffix: "-shiny",
      variantRank: 2,
    },
    {
      key: "shinyFemale",
      dir: path.join(SPRITE_ROOT, "shiny", "female"),
      nameSuffix: (n) => `${n} Shiny (Hembra)`,
      idSuffix: "-shiny-female",
      variantRank: 3,
    },
  ];

  const groupEntries = groups.map((g) => ({ ...g, entries: listSpriteEntries(g.dir) }));
  for (const g of groupEntries) console.log(`${g.key}: ${g.entries.length} files`);

  const cache = loadCache();
  const uniqueIds = [...new Set(groupEntries.flatMap((g) => g.entries.map((e) => e.id)))];

  const pokemonInfo = new Map<number, { name: string; speciesName: string }>();
  let done = 0;
  await pool(uniqueIds, 10, async (id) => {
    const info = await getPokemon(cache, id);
    if (info) pokemonInfo.set(id, info);
    done++;
    if (done % 100 === 0) {
      console.log(`resolved ${done}/${uniqueIds.length} pokemon names`);
      saveCache(cache);
    }
  });
  saveCache(cache);

  const rarityBySpecies = new Map<string, Rarity>();
  const dexNumberBySpecies = new Map<string, number>();
  const uniqueSpeciesNames = [...new Set([...pokemonInfo.values()].map((p) => p.speciesName))];
  done = 0;
  await pool(uniqueSpeciesNames, 10, async (speciesName) => {
    const r = await getRarity(cache, speciesName);
    rarityBySpecies.set(speciesName, r);
    const species = await getSpecies(cache, speciesName);
    dexNumberBySpecies.set(speciesName, species.dexNumber);
    done++;
    if (done % 100 === 0) {
      console.log(`resolved ${done}/${uniqueSpeciesNames.length} rarities`);
      saveCache(cache);
    }
  });
  saveCache(cache);

  const rows: CardRow[] = [];
  for (const g of groupEntries) {
    for (const entry of g.entries) {
      const info = pokemonInfo.get(entry.id);
      if (!info) continue;
      const rarity = rarityBySpecies.get(info.speciesName) ?? "common";
      const baseName = entry.suffix
        ? `${titleCase(info.name)} ${humanizeSuffix(info.speciesName, entry.suffix)}`
        : titleCase(info.name);
      const displayName = g.nameSuffix(baseName);
      const formIdPart = entry.suffix ? `-form-${slugSuffix(entry.suffix)}` : "";
      const cardId = `p${entry.id}${formIdPart}${g.idSuffix}`;
      const imageFilename = `${cardId}.png`;
      const dexNumber = dexNumberBySpecies.get(info.speciesName) ?? entry.id;
      const sortOrder = dexNumber * 1_000_000 + (entry.id % 1_000_000) * 10 + g.variantRank;
      rows.push({
        id: cardId,
        name: displayName,
        rarity,
        imageFilename,
        sourcePath: path.join(g.dir, entry.filename),
        sortOrder,
      });
    }
  }

  mkdirSync(CARDS_OUT_DIR, { recursive: true });
  for (const row of rows) {
    copyFileSync(row.sourcePath, path.join(CARDS_OUT_DIR, row.imageFilename));
  }

  const csvLines = ["id,name,rarity,image_filename,sort_order"];
  for (const row of rows) {
    csvLines.push(`${row.id},${row.name},${row.rarity},${row.imageFilename},${row.sortOrder}`);
  }
  writeFileSync(CSV_OUT_PATH, csvLines.join("\n") + "\n");

  const rarityCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.rarity] = (acc[r.rarity] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Wrote ${rows.length} cards to ${CSV_OUT_PATH} and copied images to ${CARDS_OUT_DIR}`);
  console.log("Rarity breakdown:", rarityCounts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
