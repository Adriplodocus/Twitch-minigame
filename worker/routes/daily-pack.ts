import { Hono } from "hono";
import type { Env } from "../types";
import { requireAuth } from "../middleware/auth";
import { notify } from "../lib/notifications";

const dailyPack = new Hono<{ Bindings: Env; Variables: { user: { twitchId: string; username: string } } }>();

dailyPack.get("/status", requireAuth, async (c) => {
  const user = c.get("user");
  const claim = await c.env.DB.prepare(
    "SELECT 1 FROM daily_pack_claims WHERE user_id = ? AND claim_date = date('now')"
  )
    .bind(user.twitchId)
    .first();
  const streakRow = await c.env.DB.prepare("SELECT current_streak FROM daily_streaks WHERE user_id = ?")
    .bind(user.twitchId)
    .first<{ current_streak: number }>();
  return c.json({ claimed: claim !== null, streak: streakRow?.current_streak ?? 0 });
});

dailyPack.post("/claim", requireAuth, async (c) => {
  const user = c.get("user");

  try {
    await c.env.DB.prepare("INSERT INTO daily_pack_claims (user_id, claim_date) VALUES (?, date('now'))")
      .bind(user.twitchId)
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      return c.json({ error: "Ya reclamado hoy" }, 409);
    }
    throw err;
  }

  const streakRow = await c.env.DB.prepare("SELECT current_streak, last_claim_date FROM daily_streaks WHERE user_id = ?")
    .bind(user.twitchId)
    .first<{ current_streak: number; last_claim_date: string | null }>();

  const yesterday = await c.env.DB.prepare("SELECT date('now', '-1 day') AS d").first<{ d: string }>();
  const wasConsecutive = streakRow?.last_claim_date === yesterday?.d;
  const streak = wasConsecutive ? streakRow!.current_streak + 1 : 1;
  const milestone = streak % 7 === 0;

  await c.env.DB.prepare(
    `INSERT INTO daily_streaks (user_id, current_streak, last_claim_date) VALUES (?, ?, date('now'))
     ON CONFLICT(user_id) DO UPDATE SET current_streak = excluded.current_streak, last_claim_date = excluded.last_claim_date`
  )
    .bind(user.twitchId, streak)
    .run();

  if (milestone) {
    await c.env.DB.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, 'daily_streak', 'apoyo')")
      .bind(user.twitchId)
      .run();
    await notify(c.env, user.twitchId, `¡Racha de ${streak} días! Sobre premium extra 🎁`, "/collection.html");
  } else {
    await c.env.DB.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, 'daily', 'gratis')")
      .bind(user.twitchId)
      .run();
  }

  return c.json({ ok: true, streak, milestone });
});

export default dailyPack;
