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

function mergeByCardId(items: TradeCardInput[]): TradeCardInput[] {
  const byCardId = new Map<string, number>();
  for (const item of items) {
    byCardId.set(item.cardId, (byCardId.get(item.cardId) ?? 0) + item.quantity);
  }
  return Array.from(byCardId, ([cardId, quantity]) => ({ cardId, quantity }));
}

trade.post("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    toUsername: string;
    offerCards: TradeCardInput[];
    requestCards: TradeCardInput[];
  }>();

  const offerCards = mergeByCardId(body.offerCards);
  const requestCards = mergeByCardId(body.requestCards);

  const toUser = await c.env.DB.prepare("SELECT twitch_id FROM users WHERE username = ?")
    .bind(body.toUsername)
    .first<{ twitch_id: string }>();
  if (!toUser) return c.json({ error: "Target user not found" }, 404);

  for (const item of offerCards) {
    const owned = await ownedQuantity(c.env, user.twitchId, item.cardId);
    if (owned < item.quantity) return c.json({ error: `You do not own enough of card ${item.cardId}` }, 409);
  }
  for (const item of requestCards) {
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
    ...offerCards.map((item) =>
      c.env.DB.prepare("INSERT INTO trade_items (offer_id, side, card_id, quantity) VALUES (?, 'from', ?, ?)").bind(
        offerId,
        item.cardId,
        item.quantity
      )
    ),
    ...requestCards.map((item) =>
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

interface TradeItemRow {
  side: "from" | "to";
  card_id: string;
  quantity: number;
}

trade.post("/offers/:id/accept", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT id, from_user, to_user, status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ id: number; from_user: string; to_user: string; status: string }>();
  if (!offer || offer.to_user !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (offer.status !== "pending") return c.json({ error: "Offer is not pending" }, 409);

  const items = await c.env.DB.prepare("SELECT side, card_id, quantity FROM trade_items WHERE offer_id = ?")
    .bind(offerId)
    .all<TradeItemRow>();

  for (const item of items.results) {
    const ownerId = item.side === "from" ? offer.from_user : offer.to_user;
    const owned = await ownedQuantity(c.env, ownerId, item.card_id);
    if (owned < item.quantity) {
      return c.json({ error: `Insufficient quantity for card ${item.card_id}` }, 409);
    }
  }

  const statements = [];
  for (const item of items.results) {
    const giver = item.side === "from" ? offer.from_user : offer.to_user;
    const receiver = item.side === "from" ? offer.to_user : offer.from_user;
    statements.push(
      c.env.DB.prepare("UPDATE user_cards SET quantity = quantity - ? WHERE user_id = ? AND card_id = ?").bind(
        item.quantity,
        giver,
        item.card_id
      )
    );
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)
         ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + ?`
      ).bind(receiver, item.card_id, item.quantity, item.quantity)
    );
  }
  statements.push(c.env.DB.prepare("UPDATE trade_offers SET status = 'accepted' WHERE id = ?").bind(offerId));
  await c.env.DB.batch(statements);

  return c.json({ status: "accepted" });
});

trade.post("/offers/:id/decline", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT to_user, status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ to_user: string; status: string }>();
  if (!offer || offer.to_user !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (offer.status !== "pending") return c.json({ error: "Offer is not pending" }, 409);

  await c.env.DB.prepare("UPDATE trade_offers SET status = 'declined' WHERE id = ?").bind(offerId).run();
  return c.json({ status: "declined" });
});

trade.post("/offers/:id/cancel", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT from_user, status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ from_user: string; status: string }>();
  if (!offer || offer.from_user !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (offer.status !== "pending") return c.json({ error: "Offer is not pending" }, 409);

  await c.env.DB.prepare("UPDATE trade_offers SET status = 'cancelled' WHERE id = ?").bind(offerId).run();
  return c.json({ status: "cancelled" });
});

export default trade;
