import type { CardView } from "./api";

const VARIANT_SUFFIXES: { suffix: string; label: string; shiny: boolean }[] = [
  { suffix: " Shiny (Hembra)", label: "Shiny (Hembra)", shiny: true },
  { suffix: " Shiny", label: "Shiny", shiny: true },
  { suffix: " (Hembra)", label: "Hembra", shiny: false },
];

export function splitCardName(name: string): {
  baseName: string;
  variantLabel: string | null;
  isShiny: boolean;
  isFemale: boolean;
} {
  for (const v of VARIANT_SUFFIXES) {
    if (name.endsWith(v.suffix)) {
      return {
        baseName: name.slice(0, -v.suffix.length),
        variantLabel: v.label,
        isShiny: v.shiny,
        isFemale: v.label.includes("Hembra"),
      };
    }
  }
  return { baseName: name, variantLabel: null, isShiny: false, isFemale: false };
}

export function collectFemaleVariantBaseNames(cards: CardView[]): Set<string> {
  const names = new Set<string>();
  for (const card of cards) {
    const { baseName, isFemale } = splitCardName(card.name);
    if (isFemale) names.add(baseName);
  }
  return names;
}

function commonWordPrefixLength(wordLists: string[][]): number {
  if (wordLists.length === 0) return 0;
  const maxLen = Math.min(...wordLists.map((w) => w.length));
  let i = 0;
  for (; i < maxLen; i++) {
    const word = wordLists[0][i];
    if (wordLists.some((w) => w[i] !== word)) break;
  }
  return i;
}

/** Groups cards by Pokédex number (encoded in sortOrder) and pulls out the
 * words that differ from the rest of the group (e.g. "Mega", "Cosplay", "A")
 * so they can be shown as a form badge instead of baked into the name. */
export function computeFormLabels(cards: CardView[]): Map<string, string> {
  const groups = new Map<number | string, CardView[]>();
  for (const card of cards) {
    const key = card.sortOrder !== undefined ? Math.floor(card.sortOrder / 1_000_000) : card.id;
    const group = groups.get(key);
    if (group) group.push(card);
    else groups.set(key, [card]);
  }

  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    const wordLists = group.map((c) => splitCardName(c.name).baseName.split(" "));
    const prefixLen = commonWordPrefixLength(wordLists);
    group.forEach((card, i) => {
      const remainder = wordLists[i].slice(prefixLen).join(" ");
      if (remainder) labels.set(card.id, remainder);
    });
  }
  return labels;
}

export function renderCardHtml(
  card: CardView,
  innerExtra = "",
  femaleVariantBaseNames?: Set<string>,
  formLabels?: Map<string, string>
): string {
  const ownedClass = card.quantity > 0 ? "" : "unowned";
  const { baseName: fullBaseName, isShiny, isFemale } = splitCardName(card.name);
  const formLabel = formLabels?.get(card.id);
  const baseName = formLabel ? fullBaseName.slice(0, -(formLabel.length + 1)) : fullBaseName;
  const hasFemaleVariant = isFemale || (femaleVariantBaseNames?.has(fullBaseName) ?? false);
  const genderIcon = isFemale
    ? `<span class="gender-icon gender-female">♀</span>`
    : hasFemaleVariant
      ? `<span class="gender-icon gender-male">♂</span>`
      : "";
  const shinyIcon = isShiny ? `<img class="shiny-icon" src="/shiny-icon.webp" alt="Shiny" />` : "";
  const variantBadge = formLabel ? `<span class="badge badge-variant">${formLabel}</span>` : "";
  const qtyBadge = card.quantity > 0 ? `<span class="card-qty">x${card.quantity}</span>` : "";

  return `
    <div class="card card-rarity-${card.rarity} ${ownedClass} card-in">
      ${genderIcon}
      ${shinyIcon}
      <img src="${card.imagePath}" alt="${baseName}" loading="lazy" />
      <p class="card-name">${baseName}</p>
      <div class="card-footer">
        <span class="card-footer-slot">${qtyBadge}</span>
        <span class="card-footer-slot">${variantBadge}</span>
      </div>
      ${innerExtra}
    </div>
  `;
}
