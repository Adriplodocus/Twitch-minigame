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

export default marketplace;
