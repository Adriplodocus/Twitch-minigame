import { Hono } from "hono";
import type { Env, Rarity } from "../types";

const overlay = new Hono<{ Bindings: Env }>();

interface EventCardRow {
  packId: number;
  broadcastAt: string;
  username: string;
  avatarUrl: string | null;
  cardId: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
}

interface OverlayEvent {
  packId: number;
  broadcastAt: string;
  username: string;
  avatarUrl: string | null;
  cards: { id: string; name: string; rarity: Rarity; imagePath: string }[];
}

overlay.get("/events", async (c) => {
  const since = c.req.query("since") ?? "";

  if (!since) {
    const now = await c.env.DB.prepare("SELECT CURRENT_TIMESTAMP AS now").first<{ now: string }>();
    return c.json({ events: [], cursor: now!.now });
  }

  const rows = await c.env.DB.prepare(
    `SELECT p.id AS packId, p.broadcast_at AS broadcastAt, u.username, u.avatar_url AS avatarUrl,
            pc.card_id AS cardId, ca.name, ca.rarity, ca.image_path AS imagePath
     FROM packs p
     JOIN users u ON u.twitch_id = p.user_id
     JOIN pack_cards pc ON pc.pack_id = p.id
     JOIN cards ca ON ca.id = pc.card_id
     WHERE p.broadcast_at IS NOT NULL AND p.broadcast_at > ?
     ORDER BY p.broadcast_at ASC, p.id ASC, pc.rowid ASC
     LIMIT 500`
  )
    .bind(since)
    .all<EventCardRow>();

  const eventsByPackId = new Map<number, OverlayEvent>();
  for (const row of rows.results) {
    let event = eventsByPackId.get(row.packId);
    if (!event) {
      event = { packId: row.packId, broadcastAt: row.broadcastAt, username: row.username, avatarUrl: row.avatarUrl, cards: [] };
      eventsByPackId.set(row.packId, event);
    }
    event.cards.push({ id: row.cardId, name: row.name, rarity: row.rarity, imagePath: row.imagePath });
  }

  const events = [...eventsByPackId.values()].slice(0, 20);
  const cursor = events.length > 0 ? events[events.length - 1].broadcastAt : since;

  return c.json({ events, cursor });
});

export default overlay;
