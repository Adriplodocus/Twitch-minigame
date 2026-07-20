import type { CardView } from "./api";
import { ensureCardTiltHandler } from "./card-tilt";
import { DISCARD_VALUE, DISCARD_VALUE_SHINY, SHINY_CONVERSION_COST } from "./coins";

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

// Mirrors worker/lib/packs.ts's shinyIdFor: female-variant ids append "-female" after the
// species, but their shiny counterpart inserts "-shiny" before that suffix, not after the whole id.
function shinyIdFor(id: string): string {
  if (id.endsWith("-female")) return `${id.slice(0, -"-female".length)}-shiny-female`;
  return `${id}-shiny`;
}

export function collectShinyCapableIds(cards: CardView[]): Set<string> {
  const shinyIds = new Set(cards.filter((c) => c.id.includes("-shiny")).map((c) => c.id));
  const capable = new Set<string>();
  for (const c of cards) {
    if (!c.id.includes("-shiny") && shinyIds.has(shinyIdFor(c.id))) capable.add(c.id);
  }
  return capable;
}

export interface CoinActionsConfig {
  coins: number;
  shinyCapableIds: Set<string>;
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
      if (el.contains(target)) return; // click landed inside this open tooltip (e.g. a coin action button) — leave it open
      if (el.closest(".card")?.querySelector(".info-btn") !== btn) el.classList.remove("open");
    });
    if (btn) btn.closest(".card")?.querySelector(".info-tooltip")?.classList.toggle("open");
  });
}

let coinActionsHandlerAttached = false;

function dispatchDiscard(el: HTMLElement): void {
  const wrap = el.closest<HTMLElement>(".coin-discard-wrap")!;
  const qtyInput = wrap.querySelector<HTMLInputElement>(".coin-discard-qty")!;
  const quantity = Math.max(1, Math.floor(Number(qtyInput.value)) || 1);
  const cardId = wrap.closest<HTMLElement>(".coin-actions")!.dataset.cardId!;
  el.dispatchEvent(new CustomEvent("card-discard", { bubbles: true, detail: { cardId, quantity } }));
}

function ensureCoinActionsHandler(): void {
  if (typeof document === "undefined") return;
  if (coinActionsHandlerAttached) return;
  coinActionsHandlerAttached = true;

  document.addEventListener("input", (e) => {
    const qtyInput = (e.target as HTMLElement).closest<HTMLInputElement>(".coin-discard-qty");
    if (!qtyInput) return;
    const max = Number(qtyInput.max) || 1;
    let quantity = Math.floor(Number(qtyInput.value));
    if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
    if (quantity > max) quantity = max;
    qtyInput.value = String(quantity);
    const unitValue = Number(qtyInput.dataset.unitValue);
    const valueEl = qtyInput.closest(".coin-discard-wrap")?.querySelector(".coin-discard-value");
    if (valueEl) valueEl.textContent = `(+${quantity * unitValue})`;
  });

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    const discardBtn = target.closest<HTMLElement>(".coin-discard-btn");
    if (discardBtn) {
      const wrap = discardBtn.closest<HTMLElement>(".coin-discard-wrap")!;
      const qty = Number(wrap.querySelector<HTMLInputElement>(".coin-discard-qty")!.value) || 1;
      if (qty > 1) {
        wrap.classList.add("confirming");
        return;
      }
      dispatchDiscard(discardBtn);
      return;
    }

    const discardYesBtn = target.closest<HTMLElement>(".coin-discard-yes");
    if (discardYesBtn) {
      dispatchDiscard(discardYesBtn);
      return;
    }

    const discardNoBtn = target.closest<HTMLElement>(".coin-discard-no");
    if (discardNoBtn) {
      discardNoBtn.closest(".coin-discard-wrap")!.classList.remove("confirming");
      return;
    }

    const convertBtn = target.closest<HTMLElement>(".coin-convert-btn");
    if (convertBtn && !convertBtn.hasAttribute("disabled")) {
      convertBtn.closest(".coin-convert-wrap")!.classList.add("confirming");
      return;
    }

    const yesBtn = target.closest<HTMLElement>(".coin-convert-yes");
    if (yesBtn) {
      const cardId = yesBtn.closest<HTMLElement>(".coin-actions")!.dataset.cardId!;
      yesBtn.dispatchEvent(new CustomEvent("card-convert-shiny", { bubbles: true, detail: { cardId } }));
      return;
    }

    const noBtn = target.closest<HTMLElement>(".coin-convert-no");
    if (noBtn) {
      noBtn.closest(".coin-convert-wrap")!.classList.remove("confirming");
    }
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
  footerBadgeHtml?: string,
  coinActions?: CoinActionsConfig
): string {
  ensureInfoTooltipHandler();
  ensureCardTiltHandler();
  ensureCoinActionsHandler();

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

  const coinActionsHtml = (() => {
    if (!coinActions || !isOwned) return "";
    const discardValue = isShiny ? DISCARD_VALUE_SHINY[card.rarity] : DISCARD_VALUE[card.rarity];
    const maxDiscard = card.quantity - 1;
    const showDiscard = maxDiscard >= 1;
    const showConvert = !isShiny && coinActions.shinyCapableIds.has(card.id) && card.quantity >= 2;
    if (!showDiscard && !showConvert) return "";

    const convertCost = SHINY_CONVERSION_COST[card.rarity];
    const canAfford = coinActions.coins >= convertCost;

    return `
      <div class="coin-actions" data-card-id="${card.id}">
        ${
          showDiscard
            ? `<div class="coin-discard-wrap">
                <input type="number" class="coin-discard-qty" min="1" max="${maxDiscard}" value="1" data-unit-value="${discardValue}" aria-label="Cantidad a descartar" />
                <button type="button" class="btn coin-discard-btn" aria-label="Descartar" title="Descartar">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                  <span class="coin-discard-value">(+${discardValue})</span>
                </button>
                <div class="coin-discard-confirm">
                  <span>¿Seguro?</span>
                  <button type="button" class="btn coin-discard-yes">Sí</button>
                  <button type="button" class="btn coin-discard-no">No</button>
                </div>
              </div>`
            : ""
        }
        ${
          showConvert
            ? `<div class="coin-convert-wrap">
                <button type="button" class="btn coin-convert-btn"${canAfford ? "" : " disabled"} aria-label="Convertir a shiny (coste ${convertCost} monedas)" title="Convertir a shiny (coste ${convertCost} monedas)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                  <img class="coin-convert-sparkle" src="/shiny-icon.webp" alt="" />
                  ${convertCost}
                </button>
                <div class="coin-convert-confirm">
                  <span>¿Seguro?</span>
                  <button type="button" class="btn coin-convert-yes">Sí</button>
                  <button type="button" class="btn coin-convert-no">No</button>
                </div>
              </div>`
            : ""
        }
      </div>
    `;
  })();

  const infoTooltip = `
    <div class="info-tooltip">
      <p><strong>${baseName}</strong></p>
      ${formLabel ? `<p>Variante: ${formLabel}</p>` : ""}
      <p>Rareza: ${RARITY_LABELS[card.rarity]}</p>
      ${isShiny ? `<p>Shiny: Sí</p>` : ""}
      ${genderLine ? `<p>Género: ${genderLine}</p>` : ""}
      ${coinActionsHtml}
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
