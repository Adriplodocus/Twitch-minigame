import type { Env } from "./types";
import { notify } from "./lib/notifications";

const PACK_AVAILABLE_CRON = "0 0 * * *";
const STREAK_AT_RISK_CRON = "0 21 * * *";

export async function handleScheduled(event: Pick<ScheduledController, "cron">, env: Env): Promise<void> {
  if (event.cron === PACK_AVAILABLE_CRON) {
    const { results } = await env.DB.prepare("SELECT twitch_id FROM users").all<{ twitch_id: string }>();
    for (const { twitch_id } of results) {
      await notify(env, twitch_id, "¡Sobre diario disponible! Canjéalo para mantener tu racha.", "/collection.html");
    }
    return;
  }

  if (event.cron === STREAK_AT_RISK_CRON) {
    const { results } = await env.DB.prepare(
      `SELECT user_id FROM daily_streaks
       WHERE current_streak > 0
       AND NOT EXISTS (
         SELECT 1 FROM daily_pack_claims
         WHERE daily_pack_claims.user_id = daily_streaks.user_id AND claim_date = date('now')
       )`
    ).all<{ user_id: string }>();
    for (const { user_id } of results) {
      await notify(
        env,
        user_id,
        "Estás a punto de perder tu racha. Canjea el sobre diario para mantenerla.",
        "/collection.html"
      );
    }
  }
}
