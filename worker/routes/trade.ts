import { Hono } from "hono";
import type { Env, SessionUser } from "../types";
import { requireAuth } from "../middleware/auth";

interface TradeCardInput {
  cardId: string;
  quantity: number;
}

const trade = new Hono<{ Bindings: Env; Variables: { user: SessionUser } }>();

trade.get("/users/:username", requireAuth, async (c) => {
  const username = c.req.param("username");
  const targetUser = await c.env.DB.prepare("SELECT twitch_id, username FROM users WHERE username = ?")
    .bind(username)
    .first<{ twitch_id: string; username: string }>();
  if (!targetUser) return c.json({ error: "Not found" }, 404);

  const cards = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.rarity, c.image_path AS imagePath, COALESCE(uc.quantity, 0) AS quantity
     FROM cards c
     LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = ?
     ORDER BY c.id`
  )
    .bind(targetUser.twitch_id)
    .all();

  return c.json({ username: targetUser.username, cards: cards.results });
});

async function ownedQuantity(env: Env, userId: string, cardId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind(userId, cardId)
    .first<{ quantity: number }>();
  return row?.quantity ?? 0;
}

trade.post("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    toUsername: string;
    offerCards: TradeCardInput[];
    requestCards: TradeCardInput[];
  }>();

  const toUser = await c.env.DB.prepare("SELECT twitch_id FROM users WHERE username = ?")
    .bind(body.toUsername)
    .first<{ twitch_id: string }>();
  if (!toUser) return c.json({ error: "Target user not found" }, 404);

  for (const item of body.offerCards) {
    const owned = await ownedQuantity(c.env, user.twitchId, item.cardId);
    if (owned < item.quantity) return c.json({ error: `You do not own enough of card ${item.cardId}` }, 409);
  }
  for (const item of body.requestCards) {
    const owned = await ownedQuantity(c.env, toUser.twitch_id, item.cardId);
    if (owned < item.quantity) return c.json({ error: `Target does not own enough of card ${item.cardId}` }, 409);
  }

  const offerResult = await c.env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user) VALUES (?, ?) RETURNING id"
  )
    .bind(user.twitchId, toUser.twitch_id)
    .first<{ id: number }>();
  const offerId = offerResult!.id;

  const statements = [
    ...body.offerCards.map((item) =>
      c.env.DB.prepare("INSERT INTO trade_items (offer_id, side, card_id, quantity) VALUES (?, 'from', ?, ?)").bind(
        offerId,
        item.cardId,
        item.quantity
      )
    ),
    ...body.requestCards.map((item) =>
      c.env.DB.prepare("INSERT INTO trade_items (offer_id, side, card_id, quantity) VALUES (?, 'to', ?, ?)").bind(
        offerId,
        item.cardId,
        item.quantity
      )
    ),
  ];
  if (statements.length > 0) await c.env.DB.batch(statements);

  return c.json({ id: offerId, status: "pending" }, 201);
});

trade.get("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  const sent = await c.env.DB.prepare(
    "SELECT id, to_user AS toUser, status FROM trade_offers WHERE from_user = ? ORDER BY created_at DESC"
  )
    .bind(user.twitchId)
    .all();
  const received = await c.env.DB.prepare(
    "SELECT id, from_user AS fromUser, status FROM trade_offers WHERE to_user = ? ORDER BY created_at DESC"
  )
    .bind(user.twitchId)
    .all();
  return c.json({ sent: sent.results, received: received.results });
});

export default trade;
