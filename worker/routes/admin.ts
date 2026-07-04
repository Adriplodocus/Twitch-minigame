import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Category, Env, Rarity } from "../types";
import { requireAdmin } from "../middleware/auth";
import { signAdminSession } from "../lib/jwt";
import { pickRandomCards } from "../lib/packs";
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
}

admin.get("/pack-grant-config", requireAdmin, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT reward_quantity AS rewardQuantity, bits_threshold AS bitsThreshold, bits_quantity AS bitsQuantity,
            sub_quantity AS subQuantity, gift_sub_multiplier AS giftSubMultiplier
     FROM pack_grant_config WHERE id = 1`
  ).first<PackGrantConfig>();
  return c.json({ config: row });
});

admin.put("/pack-grant-config", requireAdmin, async (c) => {
  const body = await c.req.json<Partial<PackGrantConfig>>().catch(() => ({}) as Partial<PackGrantConfig>);
  const { rewardQuantity, bitsThreshold, bitsQuantity, subQuantity, giftSubMultiplier } = body;

  const isValidCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1000;
  const isValidThreshold = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1000;

  if (
    !isValidCount(rewardQuantity) ||
    !isValidThreshold(bitsThreshold) ||
    !isValidCount(bitsQuantity) ||
    !isValidCount(subQuantity) ||
    !isValidCount(giftSubMultiplier)
  ) {
    return c.json({ error: "Invalid config" }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE pack_grant_config
     SET reward_quantity = ?, bits_threshold = ?, bits_quantity = ?, sub_quantity = ?, gift_sub_multiplier = ?
     WHERE id = 1`
  )
    .bind(rewardQuantity, bitsThreshold, bitsQuantity, subQuantity, giftSubMultiplier)
    .run();

  return c.json({ ok: true });
});

admin.post("/test-pack", requireAdmin, async (c) => {
  const body = await c.req
    .json<{ generation?: number; tier?: string }>()
    .catch(() => ({}) as { generation?: number; tier?: string });
  const { generation, tier } = body;

  if (!Number.isInteger(generation) || generation! < 1 || generation! > 9) {
    return c.json({ error: "Invalid generation" }, 400);
  }
  if (tier !== "gratis" && tier !== "apoyo") {
    return c.json({ error: "Invalid tier" }, 400);
  }

  const catalog = await c.env.DB.prepare("SELECT id, rarity, category FROM cards WHERE generation = ?")
    .bind(generation)
    .all<{ id: string; rarity: Rarity; category: Category }>();
  if (!catalog.results || catalog.results.length === 0) {
    return c.json({ error: "Catalog is empty" }, 500);
  }

  const picked = pickRandomCards(catalog.results, 10, tier);
  const adminName = c.get("adminName");

  const packInsert = await c.env.DB.prepare(
    `INSERT INTO packs (user_id, source, tier, granted_by, opened_at, broadcast_at, is_test)
     VALUES (?, 'admin', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`
  )
    .bind(TEST_USER_ID, tier, adminName)
    .run();
  const packId = packInsert.meta.last_row_id;

  const statements = picked.map((card) =>
    c.env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packId, card.id)
  );
  await c.env.DB.batch(statements);

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
