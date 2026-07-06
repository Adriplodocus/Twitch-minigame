import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Category, Env, Rarity } from "../types";
import { requireAdmin } from "../middleware/auth";
import { signAdminSession } from "../lib/jwt";
import { pickRandomCards, pickExactCards, type ExactCounts } from "../lib/packs";
import { grantPacks } from "../lib/grants";
import * as twitch from "../lib/twitch";

const TEST_USER_ID = "__test__";

const admin = new Hono<{ Bindings: Env }>();

admin.post("/login", async (c) => {
  const body = await c.req
    .json<{ password?: string; name?: string }>()
    .catch(() => ({}) as { password?: string; name?: string });
  const name = body.name?.trim();
  if (!name) {
    return c.json({ error: "Name required" }, 400);
  }
  if (!body.password || body.password !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "Invalid password" }, 401);
  }
  const token = await signAdminSession(c.env.JWT_SECRET, name);
  setCookie(c, "admin_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.json({ ok: true });
});

admin.post("/logout", (c) => {
  deleteCookie(c, "admin_session", { path: "/" });
  return c.json({ ok: true });
});

admin.get("/users", requireAdmin, async (c) => {
  const q = c.req.query("q") ?? "";
  const users = await c.env.DB.prepare(
    `SELECT twitch_id AS twitchId, username, avatar_url AS avatarUrl
     FROM users WHERE username LIKE ? ORDER BY username LIMIT 10`
  )
    .bind(`%${q}%`)
    .all<{ twitchId: string; username: string; avatarUrl: string | null }>();
  return c.json({ users: users.results });
});

admin.post("/lookup-user", requireAdmin, async (c) => {
  const body = await c.req.json<{ username?: string }>().catch(() => ({}) as { username?: string });
  const username = body.username?.trim();
  if (!username) return c.json({ error: "Username required" }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT twitch_id AS twitchId, username, avatar_url AS avatarUrl FROM users WHERE username = ?"
  )
    .bind(username)
    .first<{ twitchId: string; username: string; avatarUrl: string | null }>();
  if (existing) return c.json({ user: existing });

  const appAccessToken = await twitch.getAppAccessToken({
    clientId: c.env.TWITCH_CLIENT_ID,
    clientSecret: c.env.TWITCH_CLIENT_SECRET,
  });
  const twitchUser = await twitch.getUserByLogin(username, appAccessToken, c.env.TWITCH_CLIENT_ID);
  if (!twitchUser) return c.json({ error: "Twitch user not found" }, 404);

  await c.env.DB.prepare(
    `INSERT INTO users (twitch_id, username, avatar_url) VALUES (?, ?, ?)
     ON CONFLICT(twitch_id) DO UPDATE SET username = excluded.username, avatar_url = excluded.avatar_url`
  )
    .bind(twitchUser.id, twitchUser.login, twitchUser.profileImageUrl)
    .run();

  return c.json({
    user: { twitchId: twitchUser.id, username: twitchUser.login, avatarUrl: twitchUser.profileImageUrl },
  });
});

admin.post("/grant-packs", requireAdmin, async (c) => {
  const body = await c.req
    .json<{ twitchId?: string; quantity?: number; tier?: string }>()
    .catch(() => ({}) as { twitchId?: string; quantity?: number; tier?: string });
  const { twitchId, quantity, tier } = body;

  if (!twitchId || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return c.json({ error: "Invalid twitchId or quantity" }, 400);
  }
  if (tier !== "gratis" && tier !== "apoyo") {
    return c.json({ error: "Invalid tier" }, 400);
  }

  const user = await c.env.DB.prepare("SELECT twitch_id FROM users WHERE twitch_id = ?").bind(twitchId).first();
  if (!user) return c.json({ error: "User not found" }, 404);

  const adminName = c.get("adminName");
  const statements = Array.from({ length: quantity }, () =>
    c.env.DB.prepare("INSERT INTO packs (user_id, source, tier, granted_by) VALUES (?, 'admin', ?, ?)").bind(
      twitchId,
      tier,
      adminName
    )
  );
  await c.env.DB.batch(statements);

  return c.json({ ok: true });
});

interface PackGrantConfig {
  rewardQuantity: number;
  bitsThreshold: number;
  bitsQuantity: number;
  subQuantity: number;
  giftSubMultiplier: number;
  paypalThreshold: number;
  paypalQuantity: number;
}

admin.get("/pack-grant-config", requireAdmin, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT reward_quantity AS rewardQuantity, bits_threshold AS bitsThreshold, bits_quantity AS bitsQuantity,
            sub_quantity AS subQuantity, gift_sub_multiplier AS giftSubMultiplier,
            paypal_threshold AS paypalThreshold, paypal_quantity AS paypalQuantity
     FROM pack_grant_config WHERE id = 1`
  ).first<PackGrantConfig>();
  return c.json({ config: row });
});

admin.put("/pack-grant-config", requireAdmin, async (c) => {
  const body = await c.req.json<Partial<PackGrantConfig>>().catch(() => ({}) as Partial<PackGrantConfig>);
  const { rewardQuantity, bitsThreshold, bitsQuantity, subQuantity, giftSubMultiplier, paypalThreshold, paypalQuantity } =
    body;

  const isValidCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1000;
  const isValidThreshold = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1000;

  if (
    !isValidCount(rewardQuantity) ||
    !isValidThreshold(bitsThreshold) ||
    !isValidCount(bitsQuantity) ||
    !isValidCount(subQuantity) ||
    !isValidCount(giftSubMultiplier) ||
    !isValidThreshold(paypalThreshold) ||
    !isValidCount(paypalQuantity)
  ) {
    return c.json({ error: "Invalid config" }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE pack_grant_config
     SET reward_quantity = ?, bits_threshold = ?, bits_quantity = ?, sub_quantity = ?, gift_sub_multiplier = ?,
         paypal_threshold = ?, paypal_quantity = ?
     WHERE id = 1`
  )
    .bind(rewardQuantity, bitsThreshold, bitsQuantity, subQuantity, giftSubMultiplier, paypalThreshold, paypalQuantity)
    .run();

  return c.json({ ok: true });
});

admin.get("/paypal-donations", requireAdmin, async (c) => {
  const status = c.req.query("status") ?? "unmatched";
  const donations = await c.env.DB.prepare(
    `SELECT txn_id AS txnId, amount, currency, note_raw AS noteRaw, created_at AS createdAt
     FROM paypal_donations WHERE status = ? ORDER BY created_at DESC LIMIT 50`
  )
    .bind(status)
    .all<{ txnId: string; amount: number; currency: string; noteRaw: string | null; createdAt: string }>();
  return c.json({ donations: donations.results });
});

admin.post("/paypal-donations/:txnId/resolve", requireAdmin, async (c) => {
  const txnId = c.req.param("txnId");
  const body = await c.req
    .json<{ twitchId?: string; quantity?: number }>()
    .catch(() => ({}) as { twitchId?: string; quantity?: number });
  const { twitchId, quantity } = body;

  if (!twitchId || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return c.json({ error: "Invalid twitchId or quantity" }, 400);
  }

  const donation = await c.env.DB.prepare("SELECT status FROM paypal_donations WHERE txn_id = ?")
    .bind(txnId)
    .first<{ status: string }>();
  if (!donation) return c.json({ error: "Donation not found" }, 404);
  if (donation.status === "granted") return c.json({ error: "Already granted" }, 409);

  const user = await c.env.DB.prepare("SELECT twitch_id, username FROM users WHERE twitch_id = ?")
    .bind(twitchId)
    .first<{ twitch_id: string; username: string }>();
  if (!user) return c.json({ error: "User not found" }, 404);

  await grantPacks(c.env.DB, twitchId, quantity, "paypal_manual", "apoyo");
  await c.env.DB.prepare(
    `UPDATE paypal_donations SET status = 'granted', matched_user_id = ?, matched_username = ?, packs_granted = ?
     WHERE txn_id = ?`
  )
    .bind(twitchId, user.username, quantity, txnId)
    .run();

  return c.json({ ok: true });
});

admin.post("/test-pack", requireAdmin, async (c) => {
  const body = await c.req
    .json<{ generation?: number; tier?: string; counts?: ExactCounts }>()
    .catch(() => ({}) as { generation?: number; tier?: string; counts?: ExactCounts });
  const { generation, tier, counts } = body;

  if (!Number.isInteger(generation) || generation! < 1 || generation! > 9) {
    return c.json({ error: "Invalid generation" }, 400);
  }
  if (tier !== "gratis" && tier !== "apoyo") {
    return c.json({ error: "Invalid tier" }, 400);
  }

  const countValues = counts ? [counts.common, counts.rare, counts.epic, counts.legendary, counts.shiny] : [];
  const forcingCounts = countValues.some((n) => n > 0);
  if (forcingCounts) {
    if (!countValues.every((n) => Number.isInteger(n) && n >= 0)) {
      return c.json({ error: "Invalid counts" }, 400);
    }
    if (countValues.reduce((a, b) => a + b, 0) !== 10) {
      return c.json({ error: "La suma debe ser 10" }, 400);
    }
  }

  const catalog = await c.env.DB.prepare("SELECT id, rarity, category FROM cards WHERE generation = ?")
    .bind(generation)
    .all<{ id: string; rarity: Rarity; category: Category }>();
  if (!catalog.results || catalog.results.length === 0) {
    return c.json({ error: "Catalog is empty" }, 500);
  }

  let picked: { id: string; rarity: Rarity; category: Category }[];
  try {
    picked = forcingCounts ? pickExactCards(catalog.results, counts!) : pickRandomCards(catalog.results, 10, tier);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Invalid counts" }, 400);
  }
  const adminName = c.get("adminName");

  const packInsert = await c.env.DB.prepare(
    `INSERT INTO packs (user_id, source, tier, granted_by, opened_at, is_test)
     VALUES (?, 'admin', ?, ?, CURRENT_TIMESTAMP, 1)`
  )
    .bind(TEST_USER_ID, tier, adminName)
    .run();
  const packId = packInsert.meta.last_row_id;

  const statements = picked.map((card) =>
    c.env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packId, card.id)
  );
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

  return c.json({ packId, cards });
});

admin.post("/test-pack/:id/broadcast", requireAdmin, async (c) => {
  const packId = Number(c.req.param("id"));

  const pack = await c.env.DB.prepare("SELECT id, opened_at, is_test FROM packs WHERE id = ?")
    .bind(packId)
    .first<{ id: number; opened_at: string | null; is_test: number }>();
  if (!pack || pack.is_test !== 1) return c.json({ error: "Not found" }, 404);
  if (!pack.opened_at) return c.json({ error: "Pack not opened yet" }, 409);

  await c.env.DB.prepare("UPDATE packs SET broadcast_at = CURRENT_TIMESTAMP WHERE id = ?").bind(packId).run();
  return c.json({ ok: true });
});

admin.get("/history", requireAdmin, async (c) => {
  const history = await c.env.DB.prepare(
    `SELECT p.id, p.user_id AS userId, u.username, p.tier AS tier, p.source AS source,
            p.granted_by AS grantedBy, p.created_at AS createdAt
     FROM packs p JOIN users u ON u.twitch_id = p.user_id
     WHERE p.is_test = 0
     ORDER BY p.created_at DESC LIMIT 25`
  ).all<{
    id: number;
    userId: string;
    username: string;
    tier: string;
    source: string;
    grantedBy: string | null;
    createdAt: string;
  }>();
  return c.json({ history: history.results });
});

export default admin;
