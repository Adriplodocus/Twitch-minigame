import { Hono } from "hono";
import type { Env, SessionUser } from "../types";
import { requireAuth } from "../middleware/auth";

const notifications = new Hono<{ Bindings: Env; Variables: { user: SessionUser } }>();

interface NotificationRow {
  id: number;
  message: string;
  link: string | null;
  read: number;
  created_at: string;
}

notifications.get("/unread", requireAuth, async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND read = 0 LIMIT 1")
    .bind(user.twitchId)
    .first();
  return c.json({ unread: row !== null });
});

notifications.get("/", requireAuth, async (c) => {
  const user = c.get("user");

  const rows = await c.env.DB.prepare(
    "SELECT id, message, link, read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20"
  )
    .bind(user.twitchId)
    .all<NotificationRow>();

  await c.env.DB.prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0")
    .bind(user.twitchId)
    .run();

  return c.json({
    notifications: rows.results.map((r) => ({
      id: r.id,
      message: r.message,
      link: r.link,
      read: Boolean(r.read),
      createdAt: r.created_at,
    })),
  });
});

export default notifications;
