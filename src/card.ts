import type { CardView } from "./api";
import { ensureCardTiltHandler } from "./card-tilt";

export type SortField = "pokedex" | "recent" | "quantity";

export function compareCards(a: CardView, b: CardView, field: SortField): number {
  switch (field) {
    case "pokedex":
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    case "recent":
      return (a.acquiredAt ?? "").localeCompare(b.acquiredAt ?? "");
    case "quantity":
      return a.quantity - b.quantity;
  }
}

export function filterCardsByName(cards: CardView[], query: string): CardView[] {
  const q = query.trim().toLowerCase();
  if (!q) return cards;
  return cards.filter((c) => c.name.toLowerCase().includes(q));
}

const VARIANT_SUFFIXES: { suffix: string; label: string; shiny: boolean }[] = [
  { suffix: " Shiny (Hembra)", label: "Shiny (Hembra)", shiny: true },
  { suffix: " Shiny", label: "Shiny", shiny: true },
  { suffix: " (Hembra)", label: "Hembra", shiny: false },
];

// Maushold's forms differ by a middle phrase ("Family Of Three/Four"), not a
// single trailing word — computeFormLabels' generic word-diffing (built for
// cases like "Mega Charizard X/Y") instead isolates just "Three"/"Four" and
// leaves "Maushold Family Of" as the displayed name. Stripped explicitly here.
const FORM_SUFFIXES: { suffix: string; label: string }[] = [
  { suffix: " Family Of Four", label: "Family of four" },
  { suffix: " Family Of Three", label: "Family of three" },
];

export function splitCardName(name: string): {
  baseName: string;
  variantLabel: string | null;
  isShiny: boolean;
  isFemale: boolean;
  formSuffixLabel: string | null;
} {
  for (const v of VARIANT_SUFFIXES) {
    if (name.endsWith(v.suffix)) {
      const stripped = name.slice(0, -v.suffix.length);
      const form = FORM_SUFFIXES.find((f) => stripped.endsWith(f.suffix));
      return {
        baseName: form ? stripped.slice(0, -form.suffix.length) : stripped,
        variantLabel: v.label,
        isShiny: v.shiny,
        isFemale: v.label.includes("Hembra"),
        formSuffixLabel: form?.label ?? null,
      };
    }
  }
  const form = FORM_SUFFIXES.find((f) => name.endsWith(f.suffix));
  return {
    baseName: form ? name.slice(0, -form.suffix.length) : name,
    variantLabel: null,
    isShiny: false,
    isFemale: false,
    formSuffixLabel: form?.label ?? null,
  };
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

const RARITY_LABELS: Record<CardView["rarity"], string> = {
  common: "Común",
  rare: "Rara",
  epic: "Épica",
  legendary: "Legendaria",
};

let infoTooltipHandlerAttached = false;

function ensureInfoTooltipHandler(): void {
  if (typeof document === "undefined") return;
  if (infoTooltipHandlerAttached) return;
  infoTooltipHandlerAttached = true;
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>(".info-btn");
    document.querySelectorAll<HTMLElement>(".info-tooltip.open").forEach((el) => {
      if (el.closest(".card")?.querySelector(".info-btn") !== btn) el.classList.remove("open");
    });
    if (btn) btn.closest(".card")?.querySelector(".info-tooltip")?.classList.toggle("open");
  });
}

function renderSparkleDot(): string {
  const pos = () => `${(8 + Math.random() * 80).toFixed(1)}%`;
  const rot = () => `${(Math.random() * 360).toFixed(0)}deg`;
  const vars = [1, 2, 3, 4].map((i) => `--t${i}:${pos()};--l${i}:${pos()};--r${i}:${rot()}`).join(";");
  const duration = (2.4 + Math.random() * 1.6).toFixed(2);
  const delay = (Math.random() * parseFloat(duration)).toFixed(2);
  return `<span class="dot" style="${vars};animation-duration:${duration}s;animation-delay:-${delay}s;"></span>`;
}

export function renderCardHtml(
  card: CardView,
  innerExtra = "",
  femaleVariantBaseNames?: Set<string>,
  formLabels?: Map<string, string>,
  showQtyBadge = true,
  footerBadgeHtml?: string
): string {
  ensureInfoTooltipHandler();
  ensureCardTiltHandler();

  const isOwned = card.quantity > 0;
  const ownedClass = isOwned ? "" : "unowned";
  const { baseName: fullBaseName, isShiny, isFemale, formSuffixLabel } = splitCardName(card.name);
  const genericFormLabel = formLabels?.get(card.id);
  const formLabel = formSuffixLabel ?? genericFormLabel;
  // formSuffixLabel is already stripped out of fullBaseName by splitCardName;
  // genericFormLabel (from computeFormLabels) is still embedded as trailing
  // words and needs slicing off here.
  const baseName = formSuffixLabel
    ? fullBaseName
    : genericFormLabel
      ? fullBaseName.slice(0, -(genericFormLabel.length + 1))
      : fullBaseName;
  const hasFemaleVariant = isFemale || (femaleVariantBaseNames?.has(fullBaseName) ?? false);
  const genderIcon = isFemale
    ? `<span class="gender-icon gender-female">♀</span>`
    : hasFemaleVariant
      ? `<span class="gender-icon gender-male">♂</span>`
      : "";
  const shinyIcon = isShiny ? `<img class="shiny-icon" src="/shiny-icon.webp" alt="Shiny" />` : "";
  // footerBadgeHtml, when passed (even as ""), replaces the auto x-quantity
  // badge in the footer's first slot — used by callers that show their own
  // status badge (e.g. marketplace's "Tienes N") integrated into the same
  // row as the info button, instead of appending it below the card and
  // growing its height.
  const qtyBadge =
    footerBadgeHtml !== undefined
      ? footerBadgeHtml
      : showQtyBadge && card.quantity > 0
        ? `<span class="card-qty">x${card.quantity}</span>`
        : "";

  const hasFoil = isOwned && (card.rarity !== "common" || isShiny);
  const hasSparkle = isOwned && isShiny;
  const vfxClasses = `${hasFoil ? " foil" : ""}${hasSparkle ? " shiny" : ""}${isOwned ? " tiltable" : ""}`;
  const glareHtml = isOwned ? `<div class="glare"></div>` : "";
  const sparkleHtml = hasSparkle
    ? `<div class="sparkle-layer">${Array.from({ length: 7 }, () => renderSparkleDot()).join("")}</div>`
    : "";

  const genderLine = isFemale ? "Hembra" : hasFemaleVariant ? "Macho" : null;
  const infoTooltip = `
    <div class="info-tooltip">
      <p><strong>${baseName}</strong></p>
      ${formLabel ? `<p>Variante: ${formLabel}</p>` : ""}
      <p>Rareza: ${RARITY_LABELS[card.rarity]}</p>
      ${isShiny ? `<p>Shiny: Sí</p>` : ""}
      ${genderLine ? `<p>Género: ${genderLine}</p>` : ""}
    </div>
  `;

  return `
    <div class="card card-rarity-${card.rarity}${vfxClasses} ${ownedClass} card-in">
      ${glareHtml}
      ${sparkleHtml}
      ${genderIcon}
      ${shinyIcon}
      <img class="card-art" src="${card.imagePath}" alt="${baseName}" loading="lazy" />
      <p class="card-name">${baseName}</p>
      <div class="card-footer">
        <span class="card-footer-slot">${qtyBadge}</span>
        <span class="card-footer-slot">
          <button type="button" class="info-btn" aria-label="Info">i</button>
        </span>
      </div>
      ${infoTooltip}
      ${innerExtra}
    </div>
  `;
}
