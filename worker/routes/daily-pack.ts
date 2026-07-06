import { Hono } from "hono";
import type { Env } from "../types";
import { requireAuth } from "../middleware/auth";

const dailyPack = new Hono<{ Bindings: Env; Variables: { user: { twitchId: string; username: string } } }>();

dailyPack.get("/status", requireAuth, async (c) => {
  const user = c.get("user");
  const claim = await c.env.DB.prepare(
    "SELECT 1 FROM daily_pack_claims WHERE user_id = ? AND claim_date = date('now')"
  )
    .bind(user.twitchId)
    .first();
  return c.json({ claimed: claim !== null });
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

  await c.env.DB.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, 'daily', 'gratis')")
    .bind(user.twitchId)
    .run();

  return c.json({ ok: true });
});

export default dailyPack;
