import { Hono } from "hono";
import type { Env, Rarity } from "../types";
import { requireAuth } from "../middleware/auth";
import { pickRandomCards } from "../lib/packs";

const collection = new Hono<{ Bindings: Env; Variables: { user: { twitchId: string; username: string } } }>();

collection.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const cards = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.rarity, c.image_path AS imagePath, c.sort_order AS sortOrder, COALESCE(uc.quantity, 0) AS quantity
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

  const catalog = await c.env.DB.prepare("SELECT id, rarity FROM cards").all<{ id: string; rarity: Rarity }>();
  if (!catalog.results || catalog.results.length === 0) {
    return c.json({ error: "Catalog is empty" }, 500);
  }

  const picked = pickRandomCards(catalog.results, 5);

  const statements = picked.map((card) =>
    c.env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packId, card.id)
  );
  for (const card of picked) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, 1)
         ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = quantity + 1`
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
  const cards = picked.map((card) => detailsById.get(card.id)!);

  return c.json({ cards });
});

export default collection;
