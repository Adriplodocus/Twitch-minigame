import { Hono } from "hono";
import type { Category, Env, Rarity } from "../types";
import { requireAuth } from "../middleware/auth";
import { pickRandomCards, isShinyCard, shinyIdFor } from "../lib/packs";
import { DISCARD_VALUE, DISCARD_VALUE_SHINY, SHINY_CONVERSION_COST, PACK_BOOST_COST } from "../lib/coins";

const collection = new Hono<{ Bindings: Env; Variables: { user: { twitchId: string; username: string } } }>();

collection.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const cards = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.rarity, c.image_path AS imagePath, c.sort_order AS sortOrder, c.generation AS generation,
            COALESCE(uc.quantity, 0) - COALESCE(uc.reserved, 0) AS quantity, uc.updated_at AS acquiredAt
     FROM cards c
     LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = ?
     ORDER BY c.sort_order, c.id`
  )
    .bind(user.twitchId)
    .all();

  const pendingPacks = await c.env.DB.prepare(
    "SELECT id, created_at AS createdAt, tier FROM packs WHERE user_id = ? AND opened_at IS NULL ORDER BY created_at"
  )
    .bind(user.twitchId)
    .all();

  const userRow = await c.env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?")
    .bind(user.twitchId)
    .first<{ coins: number }>();

  return c.json({ cards: cards.results, pendingPacks: pendingPacks.results, coins: userRow?.coins ?? 0 });
});

function parseCardId(body: unknown): string | null {
  const cardId = (body as { cardId?: unknown } | null)?.cardId;
  return typeof cardId === "string" && cardId.length > 0 ? cardId : null;
}

function parseQuantity(body: unknown, fallback: number): number | null {
  const quantity = (body as { quantity?: unknown } | null)?.quantity;
  if (quantity === undefined) return fallback;
  return typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0 ? quantity : null;
}

collection.post("/discard", requireAuth, async (c) => {
  const user = c.get("user");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const cardId = parseCardId(body);
  if (!cardId) return c.json({ error: "Invalid cardId" }, 400);
  const quantity = parseQuantity(body, 1);
  if (quantity === null) return c.json({ error: "Invalid quantity" }, 400);

  const card = await c.env.DB.prepare("SELECT rarity FROM cards WHERE id = ?")
    .bind(cardId)
    .first<{ rarity: Rarity }>();
  if (!card) return c.json({ error: "Not found" }, 404);

  const decremented = await c.env.DB.prepare(
    "UPDATE user_cards SET quantity = quantity - ? WHERE user_id = ? AND card_id = ? AND quantity - reserved > ? RETURNING quantity"
  )
    .bind(quantity, user.twitchId, cardId, quantity)
    .first<{ quantity: number }>();
  if (!decremented) return c.json({ error: "Nothing to discard" }, 409);

  const value = (isShinyCard(cardId) ? DISCARD_VALUE_SHINY[card.rarity] : DISCARD_VALUE[card.rarity]) * quantity;

  const coinsRow = await c.env.DB.prepare("UPDATE users SET coins = coins + ? WHERE twitch_id = ? RETURNING coins")
    .bind(value, user.twitchId)
    .first<{ coins: number }>();

  return c.json({ ok: true, coins: coinsRow!.coins });
});

collection.post("/convert-shiny", requireAuth, async (c) => {
  const user = c.get("user");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const cardId = parseCardId(body);
  if (!cardId) return c.json({ error: "Invalid cardId" }, 400);
  if (isShinyCard(cardId)) return c.json({ error: "Already shiny" }, 400);

  const shinyId = shinyIdFor(cardId);
  const [card, shinyCard] = await Promise.all([
    c.env.DB.prepare("SELECT rarity FROM cards WHERE id = ?").bind(cardId).first<{ rarity: Rarity }>(),
    c.env.DB.prepare("SELECT id FROM cards WHERE id = ?").bind(shinyId).first<{ id: string }>(),
  ]);
  if (!card) return c.json({ error: "Not found" }, 404);
  if (!shinyCard) return c.json({ error: "No shiny version available" }, 404);

  const cost = SHINY_CONVERSION_COST[card.rarity];

  // Trade-off: if the batch below fails the copies guard, these coins stay spent (see task-8 report).
  const coinsRow = await c.env.DB.prepare("UPDATE users SET coins = coins - ? WHERE twitch_id = ? AND coins >= ? RETURNING coins")
    .bind(cost, user.twitchId, cost)
    .first<{ coins: number }>();
  if (!coinsRow) return c.json({ error: "Not enough coins" }, 400);

  const results = await c.env.DB.batch<{ quantity: number }>([
    c.env.DB.prepare(
      `INSERT INTO user_cards (user_id, card_id, quantity, updated_at)
       SELECT ?, ?, 1, CURRENT_TIMESTAMP
       WHERE (SELECT COALESCE(quantity, 0) - COALESCE(reserved, 0) FROM user_cards WHERE user_id = ? AND card_id = ?) >= 2
       ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP`
    ).bind(user.twitchId, shinyId, user.twitchId, cardId),
    c.env.DB.prepare(
      "UPDATE user_cards SET quantity = quantity - 1 WHERE user_id = ? AND card_id = ? AND quantity - reserved >= 2 RETURNING quantity"
    ).bind(user.twitchId, cardId),
  ]);
  const decremented = results[results.length - 1].results[0];
  if (!decremented) return c.json({ error: "Not enough copies" }, 409);

  return c.json({ ok: true, coins: coinsRow.coins });
});

collection.post("/packs/:id/open", requireAuth, async (c) => {
  const user = c.get("user");
  const packId = Number(c.req.param("id"));

  const pack = await c.env.DB.prepare("SELECT id, user_id, opened_at, tier FROM packs WHERE id = ?")
    .bind(packId)
    .first<{ id: number; user_id: string; opened_at: string | null; tier: "gratis" | "apoyo" }>();
  if (!pack || pack.user_id !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (pack.opened_at) return c.json({ error: "Pack already opened" }, 409);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const generation = Number((body as { generation?: unknown } | null)?.generation);
  if (!Number.isInteger(generation) || generation < 1 || generation > 9) {
    return c.json({ error: "Invalid generation" }, 400);
  }
  const boost = (body as { boost?: unknown } | null)?.boost === true;

  let coinsBalance: number | undefined = undefined;
  if (boost) {
    const coinsRow = await c.env.DB.prepare(
      "UPDATE users SET coins = coins - ? WHERE twitch_id = ? AND coins >= ? RETURNING coins"
    )
      .bind(PACK_BOOST_COST, user.twitchId, PACK_BOOST_COST)
      .first<{ coins: number }>();
    if (!coinsRow) return c.json({ error: "Not enough coins" }, 400);
    coinsBalance = coinsRow.coins;
  }

  const catalog = await c.env.DB.prepare(
    "SELECT id, rarity, category, sort_order AS sortOrder FROM cards WHERE generation = ?"
  )
    .bind(generation)
    .all<{
      id: string;
      rarity: Rarity;
      category: Category;
      sortOrder: number;
    }>();
  if (!catalog.results || catalog.results.length === 0) {
    return c.json({ error: "Catalog is empty" }, 500);
  }

  const picked = pickRandomCards(catalog.results, 10, pack.tier, boost);

  const statements = picked.map((card) =>
    c.env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packId, card.id)
  );
  for (const card of picked) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO user_cards (user_id, card_id, quantity, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP`
      ).bind(user.twitchId, card.id)
    );
  }
  statements.push(c.env.DB.prepare("UPDATE packs SET opened_at = CURRENT_TIMESTAMP WHERE id = ?").bind(packId));
  await c.env.DB.batch(statements);

  const uniqueIds = [...new Set(picked.map((card) => card.id))];
  const placeholders = uniqueIds.map(() => "?").join(",");
  const cardDetails = await c.env.DB.prepare(
    `SELECT id, name, rarity, image_path AS imagePath, sort_order AS sortOrder FROM cards WHERE id IN (${placeholders})`
  )
    .bind(...uniqueIds)
    .all<{ id: string; name: string; rarity: Rarity; imagePath: string; sortOrder: number }>();

  const detailsById = new Map(cardDetails.results.map((card) => [card.id, card]));
  const cards = picked.map((card) => ({ ...detailsById.get(card.id)!, quantity: 1 }));

  if (coinsBalance === undefined) {
    const userRow = await c.env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?")
      .bind(user.twitchId)
      .first<{ coins: number }>();
    coinsBalance = userRow?.coins ?? 0;
  }

  return c.json({ cards, coins: coinsBalance });
});

collection.post("/packs/:id/broadcast", requireAuth, async (c) => {
  const user = c.get("user");
  const packId = Number(c.req.param("id"));

  const pack = await c.env.DB.prepare("SELECT id, user_id, opened_at FROM packs WHERE id = ?")
    .bind(packId)
    .first<{ id: number; user_id: string; opened_at: string | null }>();
  if (!pack || pack.user_id !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (!pack.opened_at) return c.json({ error: "Pack not opened yet" }, 409);

  await c.env.DB.prepare("UPDATE packs SET broadcast_at = CURRENT_TIMESTAMP WHERE id = ?").bind(packId).run();
  return c.json({ ok: true });
});

export default collection;
