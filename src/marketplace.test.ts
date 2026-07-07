import { describe, it, expect } from "vitest";
import { formatDate, renderPublicOfferCard, renderMyOfferCard, renderWizardPickCard } from "./marketplace";
import { computeFormLabels } from "./card";

describe("formatDate", () => {
  it("formats a SQLite timestamp as dd/mm/aaaa", () => {
    expect(formatDate("2026-07-07 10:30:00")).toBe("07/07/2026");
  });
});

describe("renderPublicOfferCard", () => {
  const offer = {
    id: 1,
    creatorUsername: "otheruser",
    createdAt: "2026-07-01 00:00:00",
    demand: { cardId: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png", viewerQuantity: 0 },
    offerItems: [
      { cardId: "p2", name: "Charizard", rarity: "epic" as const, imagePath: "/p2.png", quantity: 2, viewerQuantity: 1 },
    ],
  };

  it("shows the creator username and formatted date", () => {
    const html = renderPublicOfferCard(offer);
    expect(html).toContain("Oferta de otheruser");
    expect(html).toContain("01/07/2026");
  });

  it("disables the accept button when the viewer doesn't have the demanded card", () => {
    const html = renderPublicOfferCard(offer);
    const btnMatch = html.match(/<button[^>]*class="btn mp-accept-btn"[^>]*>/)![0];
    expect(btnMatch).toContain("disabled");
  });

  it("enables the accept button when the viewer has the demanded card", () => {
    const html = renderPublicOfferCard({ ...offer, demand: { ...offer.demand, viewerQuantity: 1 } });
    const btnMatch = html.match(/<button[^>]*class="btn mp-accept-btn"[^>]*>/)![0];
    expect(btnMatch).not.toContain("disabled");
  });

  it("shows how many the viewer has of each offered card", () => {
    const html = renderPublicOfferCard(offer);
    expect(html).toContain("Tienes 1");
  });

  it("does not render a spurious auto quantity badge alongside the caller-supplied badge", () => {
    const html = renderPublicOfferCard(offer);
    expect(html).not.toContain("card-qty");
  });

  it("renders the badge inside the card footer, not appended below the card", () => {
    const html = renderPublicOfferCard(offer);
    // The demand card renders first; its badge ("Tienes 0") must land before
    // that same card's own info button, not after it.
    expect(html.indexOf("Tienes 0")).toBeLessThan(html.indexOf("info-btn"));
  });

  it("wraps the demand card in .mp-grid so it sizes the same as offered cards", () => {
    const html = renderPublicOfferCard(offer);
    expect(html).toMatch(/Demanda<\/p>\s*<div class="mp-grid">/);
  });

  it("greys out a card the viewer owns 0 of, and doesn't grey out one they own", () => {
    const html = renderPublicOfferCard(offer);
    // demand: viewerQuantity 0 -> unowned; offered card: viewerQuantity 1 -> not unowned.
    const demandCard = html.slice(html.indexOf("Demanda"), html.indexOf("Ofrece"));
    const offerCard = html.slice(html.indexOf("Ofrece"));
    expect(demandCard).toContain("unowned");
    expect(offerCard).not.toContain("unowned");
  });
});

describe("renderMyOfferCard", () => {
  const activeOffer = {
    id: 5,
    status: "active" as const,
    createdAt: "2026-07-01 00:00:00",
    acceptedAt: null,
    demand: { cardId: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png" },
    offerItems: [{ cardId: "p2", name: "Charizard", rarity: "epic" as const, imagePath: "/p2.png", quantity: 3 }],
  };

  it("shows a Cancelar button for an active offer", () => {
    const html = renderMyOfferCard(activeOffer);
    expect(html).toContain("mp-cancel-btn");
    expect(html).not.toContain("mp-delete-btn");
  });

  it("shows an Eliminar button for an accepted offer", () => {
    const html = renderMyOfferCard({ ...activeOffer, status: "accepted", acceptedAt: "2026-07-02 00:00:00" });
    expect(html).toContain("mp-delete-btn");
    expect(html).not.toContain("mp-cancel-btn");
  });

  it("shows the offered quantity as a badge", () => {
    const html = renderMyOfferCard(activeOffer);
    expect(html).toContain("x3");
  });

  it("does not render a spurious auto quantity badge alongside the caller-supplied badge", () => {
    const html = renderMyOfferCard(activeOffer);
    expect(html).not.toContain("card-qty");
  });
});

describe("renderWizardPickCard", () => {
  const card = { id: "p1", name: "Pikachu", rarity: "common" as const, imagePath: "/p1.png", quantity: 0, generation: 1 };

  it("does not render an auto quantity badge, even for a demand card the viewer owns 0 of", () => {
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

    // computeFormLabels (card.ts) keeps the shared "Mewtwo Mega" prefix in
    // the name and moves only the diverging word ("X") to the tooltip —
    // same behavior collection.html already relies on. The point of this
    // test is that SOME shortening happens, not the exact split.
    expect(html).not.toContain('class="card-name">Mewtwo Mega X<');
    expect(html).toContain("Variante: X");
  });
});
