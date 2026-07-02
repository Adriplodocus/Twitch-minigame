import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { requireAdmin } from "../middleware/auth";
import { signAdminSession } from "../lib/jwt";

const admin = new Hono<{ Bindings: Env }>();

admin.post("/login", async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  if (!body.password || body.password !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "Invalid password" }, 401);
  }
  const token = await signAdminSession(c.env.JWT_SECRET);
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

admin.post("/grant-packs", requireAdmin, async (c) => {
  const body = await c.req
    .json<{ twitchId?: string; quantity?: number }>()
    .catch(() => ({}) as { twitchId?: string; quantity?: number });
  const { twitchId, quantity } = body;

  if (!twitchId || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return c.json({ error: "Invalid twitchId or quantity" }, 400);
  }

  const user = await c.env.DB.prepare("SELECT twitch_id FROM users WHERE twitch_id = ?").bind(twitchId).first();
  if (!user) return c.json({ error: "User not found" }, 404);

  const statements = Array.from({ length: quantity }, () =>
    c.env.DB.prepare("INSERT INTO packs (user_id, source) VALUES (?, 'admin')").bind(twitchId)
  );
  await c.env.DB.batch(statements);

  return c.json({ ok: true });
});

admin.get("/history", requireAdmin, async (c) => {
  const history = await c.env.DB.prepare(
    `SELECT p.id, p.user_id AS userId, u.username, p.created_at AS createdAt
     FROM packs p JOIN users u ON u.twitch_id = p.user_id
     WHERE p.source = 'admin'
     ORDER BY p.created_at DESC LIMIT 20`
  ).all<{ id: number; userId: string; username: string; createdAt: string }>();
  return c.json({ history: history.results });
});

export default admin;
