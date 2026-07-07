import { Hono } from "hono";
import type { Env, SessionUser } from "../types";
import { requireAuth } from "../middleware/auth";

const marketplace = new Hono<{ Bindings: Env; Variables: { user: SessionUser } }>();

const MAX_OFFERS_PER_USER = 4;
const OFFER_LIFETIME_DAYS = 7;

interface OfferItemInput {
  cardId: string;
  quantity: number;
}

async function availableQuantity(env: Env, userId: string, cardId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT quantity, reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind(userId, cardId)
    .first<{ quantity: number; reserved: number }>();
  if (!row) return 0;
  return row.quantity - row.reserved;
}

function mergeByCardId(items: OfferItemInput[]): OfferItemInput[] {
  const byCardId = new Map<string, number>();
  for (const item of items) {
    byCardId.set(item.cardId, (byCardId.get(item.cardId) ?? 0) + item.quantity);
  }
  return Array.from(byCardId, ([cardId, quantity]) => ({ cardId, quantity }));
}

marketplace.post("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ demandCardId: string; offerItems: OfferItemInput[] }>();
  const offerItems = mergeByCardId(body.offerItems ?? []);

  if (offerItems.length === 0) return c.json({ error: "Debes ofrecer al menos una carta" }, 400);

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM marketplace_offers WHERE creator_id = ? AND status IN ('active', 'accepted')"
  )
    .bind(user.twitchId)
    .first<{ count: number }>();
  if ((countRow?.count ?? 0) >= MAX_OFFERS_PER_USER) {
    return c.json({ error: "Tienes el máximo de ofertas, elimina alguna antes de crear otra" }, 409);
  }

  for (const item of offerItems) {
    const available = await availableQuantity(c.env, user.twitchId, item.cardId);
    if (available < item.quantity) return c.json({ error: `No tienes suficientes cartas de ${item.cardId}` }, 409);
  }

  const offerResult = await c.env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES (?, ?) RETURNING id"
  )
    .bind(user.twitchId, body.demandCardId)
    .first<{ id: number }>();
  const offerId = offerResult!.id;

  const statements = offerItems.flatMap((item) => [
    c.env.DB.prepare("INSERT INTO marketplace_offer_items (offer_id, card_id, quantity) VALUES (?, ?, ?)").bind(
      offerId,
      item.cardId,
      item.quantity
    ),
    c.env.DB.prepare("UPDATE user_cards SET reserved = reserved + ? WHERE user_id = ? AND card_id = ?").bind(
      item.quantity,
      user.twitchId,
      item.cardId
    ),
  ]);
  await c.env.DB.batch(statements);

  return c.json({ id: offerId, status: "active" }, 201);
});

async function releaseReservationAndDeleteOffer(env: Env, offerId: number, creatorId: string): Promise<void> {
  // Atomic claim: DELETE ... RETURNING is a single write statement, and SQLite/D1 serializes writes,
  // so exactly one concurrent caller can ever see a non-empty result for the same offerId here.
  // Combining the "read what needs releasing" and "delete the items" steps into one statement closes
  // the old race window where a caller could read a stale (already-deleted-by-someone-else) snapshot,
  // or read a live snapshot that a faster caller then deleted out from under it before either reached
  // the offer-row claim. Whichever caller's delete actually removes rows owns the release below; a
  // caller that loses the race finds the rows already gone, gets an empty list, and returns untouched.
  // Deleting the items (children) before the offer (parent) also satisfies the FK from
  // marketplace_offer_items to marketplace_offers.
  const items = await env.DB.prepare(
    "DELETE FROM marketplace_offer_items WHERE offer_id = ? RETURNING card_id, quantity"
  )
    .bind(offerId)
    .all<{ card_id: string; quantity: number }>();
  if (items.results.length === 0) return;

  const statements = [
    env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ?").bind(offerId),
    ...items.results.map((item) =>
      env.DB.prepare("UPDATE user_cards SET reserved = reserved - ? WHERE user_id = ? AND card_id = ?").bind(
        item.quantity,
        creatorId,
        item.card_id
      )
    ),
  ];
  await env.DB.batch(statements);
}

async function sweepExpiredOffers(env: Env): Promise<void> {
  const expiredActive = await env.DB.prepare(
    "SELECT id FROM marketplace_offers WHERE status = 'active' AND created_at <= datetime('now', ?)"
  )
    .bind(`-${OFFER_LIFETIME_DAYS} days`)
    .all<{ id: number }>();

  for (const { id } of expiredActive.results) {
    const offer = await env.DB.prepare("SELECT creator_id FROM marketplace_offers WHERE id = ?")
      .bind(id)
      .first<{ creator_id: string }>();
    if (!offer) continue; // already claimed and deleted by a concurrent sweep

    await releaseReservationAndDeleteOffer(env, id, offer.creator_id);
  }

  const expiredAccepted = await env.DB.prepare(
    "SELECT id FROM marketplace_offers WHERE status = 'accepted' AND accepted_at <= datetime('now', ?)"
  )
    .bind(`-${OFFER_LIFETIME_DAYS} days`)
    .all<{ id: number }>();
  for (const { id } of expiredAccepted.results) {
    // Unlike releaseReservationAndDeleteOffer, this branch has no reserved units to release, so
    // there's nothing that depends on "winning" a race — deleting the (possibly already-gone)
    // children then the (possibly already-gone) parent is safe to run unconditionally: a concurrent
    // sweep that already removed these rows just makes these statements harmless no-ops.
    await env.DB.prepare("DELETE FROM marketplace_offer_items WHERE offer_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ?").bind(id).run();
  }
}

interface MarketplaceItemRow {
  offer_id: number;
  cardId: string;
  name: string;
  rarity: string;
  imagePath: string;
  quantity: number;
}

async function itemsByOfferIds(
  env: Env,
  offerIds: number[]
): Promise<Map<number, { cardId: string; name: string; rarity: string; imagePath: string; quantity: number }[]>> {
  const byOfferId = new Map<
    number,
    { cardId: string; name: string; rarity: string; imagePath: string; quantity: number }[]
  >();
  if (offerIds.length === 0) return byOfferId;

  const placeholders = offerIds.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT oi.offer_id, c.id AS cardId, c.name, c.rarity, c.image_path AS imagePath, oi.quantity
     FROM marketplace_offer_items oi JOIN cards c ON c.id = oi.card_id
     WHERE oi.offer_id IN (${placeholders})`
  )
    .bind(...offerIds)
    .all<MarketplaceItemRow>();

  for (const row of rows.results) {
    const list = byOfferId.get(row.offer_id) ?? [];
    list.push({ cardId: row.cardId, name: row.name, rarity: row.rarity, imagePath: row.imagePath, quantity: row.quantity });
    byOfferId.set(row.offer_id, list);
  }
  return byOfferId;
}

interface MineOfferRow {
  id: number;
  demandCardId: string;
  status: string;
  createdAt: string;
  acceptedAt: string | null;
  demandName: string;
  demandRarity: string;
  demandImagePath: string;
}

marketplace.get("/offers/mine", requireAuth, async (c) => {
  const user = c.get("user");
  await sweepExpiredOffers(c.env);

  const offers = await c.env.DB.prepare(
    `SELECT o.id, o.demand_card_id AS demandCardId, o.status, o.created_at AS createdAt, o.accepted_at AS acceptedAt,
            dc.name AS demandName, dc.rarity AS demandRarity, dc.image_path AS demandImagePath
     FROM marketplace_offers o JOIN cards dc ON dc.id = o.demand_card_id
     WHERE o.creator_id = ? ORDER BY o.created_at DESC`
  )
    .bind(user.twitchId)
    .all<MineOfferRow>();

  const items = await itemsByOfferIds(c.env, offers.results.map((o) => o.id));

  return c.json({
    offers: offers.results.map((o) => ({
      id: o.id,
      status: o.status,
      createdAt: o.createdAt,
      acceptedAt: o.acceptedAt,
      demand: { cardId: o.demandCardId, name: o.demandName, rarity: o.demandRarity, imagePath: o.demandImagePath },
      offerItems: items.get(o.id) ?? [],
    })),
  });
});

marketplace.post("/offers/:id/cancel", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT creator_id, status FROM marketplace_offers WHERE id = ?")
    .bind(offerId)
    .first<{ creator_id: string; status: string }>();
  if (!offer || offer.creator_id !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (offer.status !== "active") return c.json({ error: "La oferta no está activa" }, 409);

  await releaseReservationAndDeleteOffer(c.env, offerId, user.twitchId);

  return c.json({ ok: true });
});

marketplace.delete("/offers/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT creator_id, status FROM marketplace_offers WHERE id = ?")
    .bind(offerId)
    .first<{ creator_id: string; status: string }>();
  if (!offer || offer.creator_id !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (offer.status !== "accepted") return c.json({ error: "Solo se pueden eliminar ofertas aceptadas" }, 409);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM marketplace_offer_items WHERE offer_id = ?").bind(offerId),
    c.env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ?").bind(offerId),
  ]);

  return c.json({ ok: true });
});

export default marketplace;
