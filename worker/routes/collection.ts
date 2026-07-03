import { Hono } from "hono";
import type { Category, Env, Rarity } from "../types";
import { requireAuth } from "../middleware/auth";
import { pickRandomCards } from "../lib/packs";

const collection = new Hono<{ Bindings: Env; Variables: { user: { twitchId: string; username: string } } }>();

collection.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const cards = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.rarity, c.image_path AS imagePath, c.sort_order AS sortOrder, c.generation AS generation,
            COALESCE(uc.quantity, 0) AS quantity, uc.updated_at AS acquiredAt
     FROM cards c
     LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = ?
     ORDER BY c.sort_order, c.id`
  )
    .bind(user.twitchId)
    .all();

  const pendingPacks = await c.env.DB.prepare(
    "SELECT id, created_at AS createdAt FROM packs WHERE user_id = ? AND opened_at IS NULL ORDER BY created_at"
  )
    .bind(user.twitchId)
    .all();

  return c.json({ cards: cards.results, pendingPacks: pendingPacks.results });
});

collection.post("/packs/:id/open", requireAuth, async (c) => {
  const user = c.get("user");
  const packId = Number(c.req.param("id"));

  const pack = await c.env.DB.prepare("SELECT id, user_id, opened_at FROM packs WHERE id = ?")
    .bind(packId)
    .first<{ id: number; user_id: string; opened_at: string | null }>();
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

  const catalog = await c.env.DB.prepare("SELECT id, rarity, category FROM cards WHERE generation = ?")
    .bind(generation)
    .all<{
      id: string;
      rarity: Rarity;
      category: Category;
    }>();
  if (!catalog.results || catalog.results.length === 0) {
    return c.json({ error: "Catalog is empty" }, 500);
  }

  const picked = pickRandomCards(catalog.results, 10);

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
    `SELECT id, name, rarity, image_path AS imagePath FROM cards WHERE id IN (${placeholders})`
  )
    .bind(...uniqueIds)
    .all<{ id: string; name: string; rarity: Rarity; imagePath: string }>();

  const detailsById = new Map(cardDetails.results.map((card) => [card.id, card]));
  const cards = picked.map((card) => ({ ...detailsById.get(card.id)!, quantity: 1 }));

  return c.json({ cards });
});

export default collection;
