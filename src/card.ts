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
} {
  for (const v of VARIANT_SUFFIXES) {
    if (name.endsWith(v.suffix)) {
      return { baseName: name.slice(0, -v.suffix.length), variantLabel: v.label, isShiny: v.shiny };
    }
  }
  return { baseName: name, variantLabel: null, isShiny: false };
}

export function renderCardHtml(card: CardView, innerExtra = ""): string {
  const ownedClass = card.quantity > 0 ? "" : "unowned";
  const { baseName, variantLabel, isShiny } = splitCardName(card.name);
  const rarityBadge =
    card.rarity === "common" ? "" : `<span class="badge badge-rarity rarity-${card.rarity}">${card.rarity}</span>`;
  const variantBadge = variantLabel ? `<span class="badge badge-variant">${variantLabel}</span>` : "";
  const shinyIcon = isShiny ? `<img class="shiny-icon" src="/shiny-icon.png" alt="Shiny" />` : "";
  const qtyBadge = card.quantity > 0 ? `<span class="card-qty">x${card.quantity}</span>` : "";

  return `
    <div class="card card-rarity-${card.rarity} ${ownedClass} card-in">
      ${rarityBadge}
      ${shinyIcon}
      <img src="${card.imagePath}" alt="${baseName}" loading="lazy" />
      <p class="card-name">${baseName}</p>
      ${variantBadge}
      ${qtyBadge}
      ${innerExtra}
    </div>
  `;
}
