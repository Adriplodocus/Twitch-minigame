import type { Env } from "../types";

export async function closeDemand(env: Env, demandId: number, exceptOfferId?: number): Promise<void> {
  const declineStatement =
    exceptOfferId === undefined
      ? env.DB.prepare(
          "UPDATE trade_offers SET status = 'declined', marketplace_demand_id = NULL WHERE marketplace_demand_id = ? AND status = 'pending'"
        ).bind(demandId)
      : env.DB.prepare(
          "UPDATE trade_offers SET status = CASE WHEN status = 'pending' AND id != ? THEN 'declined' ELSE status END, marketplace_demand_id = NULL WHERE marketplace_demand_id = ?"
        ).bind(exceptOfferId, demandId);

  await env.DB.batch([declineStatement, env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ?").bind(demandId)]);
}
