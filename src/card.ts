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

export function renderCardHtml(card: CardView, innerExtra = "", femaleVariantBaseNames?: Set<string>): string {
  const ownedClass = card.quantity > 0 ? "" : "unowned";
  const { baseName, isShiny, isFemale } = splitCardName(card.name);
  const hasFemaleVariant = isFemale || (femaleVariantBaseNames?.has(baseName) ?? false);
  const genderIcon = isFemale
    ? `<span class="gender-icon gender-female">♀</span>`
    : hasFemaleVariant
      ? `<span class="gender-icon gender-male">♂</span>`
      : "";
  const shinyIcon = isShiny ? `<img class="shiny-icon" src="/shiny-icon.webp" alt="Shiny" />` : "";
  const qtyBadge = card.quantity > 0 ? `<span class="card-qty">x${card.quantity}</span>` : "";

  return `
    <div class="card card-rarity-${card.rarity} ${ownedClass} card-in">
      ${genderIcon}
      ${shinyIcon}
      <img src="${card.imagePath}" alt="${baseName}" loading="lazy" />
      <p class="card-name">${baseName}</p>
      ${qtyBadge}
      ${innerExtra}
    </div>
  `;
}
