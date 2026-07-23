import { Hono } from "hono";
import type { Env, SessionUser } from "../types";
import { requireAuth } from "../middleware/auth";
import { closeDemand } from "../lib/marketplace-demands";

const marketplace = new Hono<{ Bindings: Env; Variables: { user: SessionUser } }>();

const MAX_DEMANDS_PER_USER = 4;
const DEMAND_LIFETIME_DAYS = 7;
const PAGE_SIZE = 6;

async function sweepExpiredDemands(env: Env): Promise<void> {
  const expired = await env.DB.prepare(
    "SELECT id FROM marketplace_offers WHERE created_at <= datetime('now', ?)"
  )
    .bind(`-${DEMAND_LIFETIME_DAYS} days`)
    .all<{ id: number }>();
  for (const { id } of expired.results) {
    await closeDemand(env, id);
  }
}

marketplace.post("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ demandCardId?: string }>();
  if (!body.demandCardId) return c.json({ error: "Falta el cromo demandado" }, 400);

  const demandCard = await c.env.DB.prepare("SELECT 1 FROM cards WHERE id = ?").bind(body.demandCardId).first();
  if (!demandCard) return c.json({ error: "Carta demandada no existe" }, 400);

  const countRow = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM marketplace_offers WHERE creator_id = ?")
    .bind(user.twitchId)
    .first<{ count: number }>();
  if ((countRow?.count ?? 0) >= MAX_DEMANDS_PER_USER) {
    return c.json({ error: "Tienes el máximo de demandas, elimina alguna antes de crear otra" }, 409);
  }

  const result = await c.env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES (?, ?) RETURNING id")
    .bind(user.twitchId, body.demandCardId)
    .first<{ id: number }>();

  return c.json({ id: result!.id }, 201);
});

interface MineDemandRow {
  id: number;
  createdAt: string;
  demandCardId: string;
  demandName: string;
  demandRarity: string;
  demandImagePath: string;
}

marketplace.get("/offers/mine", requireAuth, async (c) => {
  const user = c.get("user");
  await sweepExpiredDemands(c.env);

  const offers = await c.env.DB.prepare(
    `SELECT o.id, o.created_at AS createdAt,
            dc.id AS demandCardId, dc.name AS demandName, dc.rarity AS demandRarity, dc.image_path AS demandImagePath
     FROM marketplace_offers o JOIN cards dc ON dc.id = o.demand_card_id
     WHERE o.creator_id = ? ORDER BY o.created_at DESC`
  )
    .bind(user.twitchId)
    .all<MineDemandRow>();

  return c.json({
    offers: offers.results.map((o) => ({
      id: o.id,
      createdAt: o.createdAt,
      demand: { cardId: o.demandCardId, name: o.demandName, rarity: o.demandRarity, imagePath: o.demandImagePath },
    })),
  });
});

interface SingleDemandRow {
  id: number;
  creatorUsername: string;
  demandCardId: string;
  demandName: string;
  demandRarity: string;
  demandImagePath: string;
}

marketplace.get("/offers/:id", requireAuth, async (c) => {
  await sweepExpiredDemands(c.env);
  const id = Number(c.req.param("id"));

  const row = await c.env.DB.prepare(
    `SELECT o.id, u.username AS creatorUsername,
            dc.id AS demandCardId, dc.name AS demandName, dc.rarity AS demandRarity, dc.image_path AS demandImagePath
     FROM marketplace_offers o
     JOIN users u ON u.twitch_id = o.creator_id
     JOIN cards dc ON dc.id = o.demand_card_id
     WHERE o.id = ?`
  )
    .bind(id)
    .first<SingleDemandRow>();
  if (!row) return c.json({ error: "Not found" }, 404);

  return c.json({
    id: row.id,
    creatorUsername: row.creatorUsername,
    demand: { cardId: row.demandCardId, name: row.demandName, rarity: row.demandRarity, imagePath: row.demandImagePath },
  });
});

marketplace.post("/offers/:id/cancel", requireAuth, async (c) => {
  const user = c.get("user");
  const offerId = Number(c.req.param("id"));
  const offer = await c.env.DB.prepare("SELECT creator_id FROM marketplace_offers WHERE id = ?")
    .bind(offerId)
    .first<{ creator_id: string }>();
  if (!offer || offer.creator_id !== user.twitchId) return c.json({ error: "Not found" }, 404);

  await closeDemand(c.env, offerId);
  return c.json({ ok: true });
});

interface PublicDemandRow {
  id: number;
  creatorUsername: string;
  createdAt: string;
  demandCardId: string;
  demandName: string;
  demandRarity: string;
  demandImagePath: string;
  demandViewerQty: number;
}

marketplace.get("/offers", requireAuth, async (c) => {
  const user = c.get("user");
  await sweepExpiredDemands(c.env);

  const page = Math.max(1, Number(c.req.query("page") ?? "1"));
  const demandQuery = c.req.query("demandQuery") ?? "";
  const offset = (page - 1) * PAGE_SIZE;

  const whereClause = `o.creator_id != ? AND (? = '' OR dc.name LIKE '%' || ? || '%')`;
  const filterParams = [user.twitchId, demandQuery, demandQuery];

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM marketplace_offers o JOIN cards dc ON dc.id = o.demand_card_id WHERE ${whereClause}`
  )
    .bind(...filterParams)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT o.id, u.username AS creatorUsername, o.created_at AS createdAt,
            dc.id AS demandCardId, dc.name AS demandName, dc.rarity AS demandRarity, dc.image_path AS demandImagePath,
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
    .all<PublicDemandRow>();

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
    })),
    totalCount: countRow?.count ?? 0,
    page,
    pageSize: PAGE_SIZE,
  });
});

export default marketplace;
