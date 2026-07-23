import { describe, it, expect } from "vitest";
import { formatDate, renderPublicDemandCard, renderMyDemandCard, renderWizardPickCard } from "./marketplace";
import { computeFormLabels } from "./card";

describe("formatDate", () => {
  it("formats a SQLite timestamp as dd/mm/aaaa", () => {
    expect(formatDate("2026-07-07 10:30:00")).toBe("07/07/2026");
  });
});

describe("renderPublicDemandCard", () => {
  const offer = {
    id: 1,
    creatorUsername: "otheruser",
    createdAt: "2026-07-01 00:00:00",
    demand: { cardId: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png", viewerQuantity: 0 },
  };

  it("shows the creator username and formatted date", () => {
    const html = renderPublicDemandCard(offer);
    expect(html).toContain("Demanda de otheruser");
    expect(html).toContain("01/07/2026");
  });

  it("disables the respond button when the viewer doesn't have the demanded card", () => {
    const html = renderPublicDemandCard(offer);
    const btnMatch = html.match(/<button[^>]*class="btn mp-respond-btn"[^>]*>/)![0];
    expect(btnMatch).toContain("disabled");
  });

  it("enables the respond button when the viewer has the demanded card", () => {
    const html = renderPublicDemandCard({ ...offer, demand: { ...offer.demand, viewerQuantity: 1 } });
    const btnMatch = html.match(/<button[^>]*class="btn mp-respond-btn"[^>]*>/)![0];
    expect(btnMatch).not.toContain("disabled");
  });

  it("greys out the demand card when the viewer owns 0", () => {
    const html = renderPublicDemandCard(offer);
    expect(html).toContain("unowned");
  });

  it("does not render a spurious auto quantity badge", () => {
    const html = renderPublicDemandCard(offer);
    expect(html).not.toContain("card-qty");
  });
});

describe("renderMyDemandCard", () => {
  const demand = {
    id: 5,
    createdAt: "2026-07-01 00:00:00",
    demand: { cardId: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png" },
  };

  it("shows a Cancelar button", () => {
    const html = renderMyDemandCard(demand);
    expect(html).toContain("mp-cancel-btn");
  });

  it("does not render a spurious auto quantity badge", () => {
    const html = renderMyDemandCard(demand);
    expect(html).not.toContain("card-qty");
  });
});

describe("renderWizardPickCard", () => {
  const card = { id: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png", quantity: 0, generation: 1 };

  it("does not render an auto quantity badge, even for a card the viewer owns 0 of", () => {
    const html = renderWizardPickCard(card);
    expect(html).not.toContain("card-qty");
  });

  it("still forces quantity to 1 so VFX (foil/shiny/tiltable) stay active", () => {
    const html = renderWizardPickCard(card);
    expect(html).not.toContain("unowned");
  });

  it("strips a form variant (e.g. Mega X) out of the visible name when formLabels are provided", () => {
    const megaX = { id: "p10043", name: "Mewtwo Mega X", rarity: "legendary" as const, imagePath: "/p10043.png", quantity: 0, generation: 1, sortOrder: 150100430 };
    const megaY = { id: "p10044", name: "Mewtwo Mega Y", rarity: "legendary" as const, imagePath: "/p10044.png", quantity: 0, generation: 1, sortOrder: 150100440 };
    const formLabels = computeFormLabels([megaX, megaY]);

    const html = renderWizardPickCard(megaX, undefined, formLabels);

    expect(html).not.toContain('class="card-name">Mewtwo Mega X<');
    expect(html).toContain("Variante: X");
  });
});
