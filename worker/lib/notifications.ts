import type { Env } from "../types";

export async function notify(env: Env, userId: string, message: string, link?: string): Promise<void> {
  await env.DB.prepare("INSERT INTO notifications (user_id, message, link) VALUES (?, ?, ?)")
    .bind(userId, message, link ?? null)
    .run();

  await env.DB.prepare(
    `DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
      SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20
    )`
  )
    .bind(userId, userId)
    .run();
}
