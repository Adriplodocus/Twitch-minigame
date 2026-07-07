import { Hono } from "hono";
import type { Env, SessionUser } from "../types";
import { requireAuth } from "../middleware/auth";
import { notify } from "../lib/notifications";

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
  // Snapshot items BEFORE the claim — this is just data gathering, not part of the atomicity guarantee.
  // A concurrent caller may delete these out from under us after we read them; that's fine, see below.
  const items = await env.DB.prepare("SELECT card_id, quantity FROM marketplace_offer_items WHERE offer_id = ?")
    .bind(offerId)
    .all<{ card_id: string; quantity: number }>();

  // Atomic claim: delete items then the offer row in ONE batch. D1 serializes writes, so exactly one
  // concurrent caller's batch executes first as a whole unit. The offer-row RETURNING is the sole
  // winner signal — it's independent of how many items existed, so an offer with zero items (reachable
  // if POST /offers is ever interrupted between inserting the offer row and batching its items) is
  // still claimed and deleted exactly once instead of being mistaken for "already claimed by someone
  // else". Deleting items (children) before the offer (parent) satisfies the FK from
  // marketplace_offer_items to marketplace_offers within this same batch.
  const claimStatements = [
    env.DB.prepare("DELETE FROM marketplace_offer_items WHERE offer_id = ?").bind(offerId),
    env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ? RETURNING id").bind(offerId),
  ];
  const results = await env.DB.batch<{ id: number }>(claimStatements);
  const offerDeleteResult = results[results.length - 1];
  if (offerDeleteResult.results.length === 0) return; // someone else already claimed this offer — no-op

  // We won the claim: release reserved using OUR snapshot (accurate real quantities; empty if the
  // offer legitimately had zero items — the loop below then just does nothing).
  if (items.results.length > 0) {
    const releaseStatements = items.results.map((item) =>
      env.DB.prepare("UPDATE user_cards SET reserved = reserved - ? WHERE user_id = ? AND card_id = ?").bind(
        item.quantity,
        creatorId,
        item.card_id
      )
    );
    await env.DB.batch(releaseStatements);
  }
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
    // Unlike releaseReservationAndDeleteOffer, this branch has no reserved units to release, so there's
    // nothing that depends on "winning" the claim. Still delete items + offer in the same shape (one
    // batch, offer-row RETURNING as the signal) for consistency and so a racing sweep that already
    // deleted these rows is a harmless detected no-op rather than a second redundant delete.
    const claimStatements = [
      env.DB.prepare("DELETE FROM marketplace_offer_items WHERE offer_id = ?").bind(id),
      env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ? RETURNING id").bind(id),
    ];
    const results = await env.DB.batch<{ id: number }>(claimStatements);
    const offerDeleteResult = results[results.length - 1];
    if (offerDeleteResult.results.length === 0) continue; // already deleted by a concurrent sweep — no-op
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

const PAGE_SIZE = 6;

async function viewerQuantitiesByCardIds(env: Env, userId: string, cardIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (cardIds.length === 0) return result;
  const placeholders = cardIds.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT card_id, quantity - reserved AS available FROM user_cards WHERE user_id = ? AND card_id IN (${placeholders})`
  )
    .bind(userId, ...cardIds)
    .all<{ card_id: string; available: number }>();
  for (const row of rows.results) result.set(row.card_id, row.available);
  return result;
}

interface PublicOfferRow {
  id: number;
  creatorUsername: string;
  demandCardId: string;
  createdAt: string;
  demandName: string;
  demandRarity: string;
  demandImagePath: string;
  demandViewerQty: number;
}

marketplace.get("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  await sweepExpiredOffers(c.env);

  const page = Math.max(1, Number(c.req.query("page") ?? "1"));
  const demandQuery = c.req.query("demandQuery") ?? "";
  const offerQuery = c.req.query("offerQuery") ?? "";
  const offset = (page - 1) * PAGE_SIZE;

  const whereClause = `
    o.status = 'active' AND o.creator_id != ?
    AND (? = '' OR dc.name LIKE '%' || ? || '%')
    AND (? = '' OR EXISTS (
      SELECT 1 FROM marketplace_offer_items oi2 JOIN cards oc2 ON oc2.id = oi2.card_id
      WHERE oi2.offer_id = o.id AND oc2.name LIKE '%' || ? || '%'
    ))
  `;
  const filterParams = [user.twitchId, demandQuery, demandQuery, offerQuery, offerQuery];

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM marketplace_offers o JOIN cards dc ON dc.id = o.demand_card_id WHERE ${whereClause}`
  )
    .bind(...filterParams)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT o.id, u.username AS creatorUsername, o.demand_card_id AS demandCardId, o.created_at AS createdAt,
            dc.name AS demandName, dc.rarity AS demandRarity, dc.image_path AS demandImagePath,
            COALESCE(v.quantity, 0) - COALESCE(v.reserved, 0) AS demandViewerQty
     FROM marketplace_offers o
     JOIN users u ON u.twitch_id = o.creator_id
     JOIN cards dc ON dc.id = o.demand_card_id
     LEFT JOIN user_cards v ON v.card_id = o.demand_card_id AND v.user_id = ?
     WHERE ${whereClause}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ? OFFSET ?`
  )
    .bind(user.twitchId, ...filterParams, PAGE_SIZE, offset)
    .all<PublicOfferRow>();

  const offerIds = rows.results.map((r) => r.id);
  const items = await itemsByOfferIds(c.env, offerIds);
  const allItemCardIds = Array.from(new Set(Array.from(items.values()).flat().map((i) => i.cardId)));
  const viewerQuantities = await viewerQuantitiesByCardIds(c.env, user.twitchId, allItemCardIds);

  return c.json({
    offers: rows.results.map((r) => ({
      id: r.id,
      creatorUsername: r.creatorUsername,
      createdAt: r.createdAt,
      demand: {
        cardId: r.demandCardId,
        name: r.demandName,
        rarity: r.demandRarity,
        imagePath: r.demandImagePath,
        viewerQuantity: r.demandViewerQty,
      },
      offerItems: (items.get(r.id) ?? []).map((i) => ({ ...i, viewerQuantity: viewerQuantities.get(i.cardId) ?? 0 })),
    })),
    totalCount: countRow?.count ?? 0,
    page,
    pageSize: PAGE_SIZE,
  });
});

marketplace.post("/offers/:id/accept", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  await sweepExpiredOffers(c.env);

  const offer = await c.env.DB.prepare(
    "SELECT creator_id, demand_card_id AS demandCardId, status FROM marketplace_offers WHERE id = ?"
  )
    .bind(offerId)
    .first<{ creator_id: string; demandCardId: string; status: string }>();
  if (!offer) return c.json({ error: "Not found" }, 404);
  if (offer.creator_id === user.twitchId) return c.json({ error: "No puedes aceptar tu propia oferta" }, 400);

  const guardResult = await c.env.DB.prepare(
    "UPDATE marketplace_offers SET status = 'accepted', acceptor_id = ?, accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'"
  )
    .bind(user.twitchId, offerId)
    .run();
  if (guardResult.meta.changes === 0) return c.json({ error: "Oferta ya no disponible" }, 409);

  const acceptorAvailable = await availableQuantity(c.env, user.twitchId, offer.demandCardId);
  if (acceptorAvailable < 1) {
    await c.env.DB.prepare(
      "UPDATE marketplace_offers SET status = 'active', acceptor_id = NULL, accepted_at = NULL WHERE id = ?"
    )
      .bind(offerId)
      .run();
    return c.json({ error: "No tienes el cromo demandado" }, 409);
  }

  const items = await c.env.DB.prepare("SELECT card_id, quantity FROM marketplace_offer_items WHERE offer_id = ?")
    .bind(offerId)
    .all<{ card_id: string; quantity: number }>();

  const statements = items.results.flatMap((item) => [
    c.env.DB.prepare(
      "UPDATE user_cards SET quantity = quantity - ?, reserved = reserved - ? WHERE user_id = ? AND card_id = ?"
    ).bind(item.quantity, item.quantity, offer.creator_id, item.card_id),
    c.env.DB.prepare(
      `INSERT INTO user_cards (user_id, card_id, quantity, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP`
    ).bind(user.twitchId, item.card_id, item.quantity, item.quantity),
  ]);
  statements.push(
    c.env.DB.prepare("UPDATE user_cards SET quantity = quantity - 1 WHERE user_id = ? AND card_id = ?").bind(
      user.twitchId,
      offer.demandCardId
    )
  );
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO user_cards (user_id, card_id, quantity, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP`
    ).bind(offer.creator_id, offer.demandCardId)
  );
  await c.env.DB.batch(statements);

  await notify(c.env, offer.creator_id, "Una oferta tuya ha sido aceptada", "/marketplace.html?tab=mine");

  return c.json({ status: "accepted" });
});

export default marketplace;
