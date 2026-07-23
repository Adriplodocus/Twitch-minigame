import type { Env } from "../types";

export async function closeDemand(env: Env, demandId: number, exceptOfferId?: number): Promise<void> {
  const declineStatement =
    exceptOfferId === undefined
      ? env.DB.prepare(
          "UPDATE trade_offers SET status = 'declined' WHERE marketplace_demand_id = ? AND status = 'pending'"
        ).bind(demandId)
      : env.DB.prepare(
          "UPDATE trade_offers SET status = 'declined' WHERE marketplace_demand_id = ? AND status = 'pending' AND id != ?"
        ).bind(demandId, exceptOfferId);

  await env.DB.batch([env.DB.prepare("DELETE FROM marketplace_offers WHERE id = ?").bind(demandId), declineStatement]);
}
