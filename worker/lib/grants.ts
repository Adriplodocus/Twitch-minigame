import type { PackTier } from "./packs";

export async function upsertUser(db: D1Database, userId: string, username: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (twitch_id, username) VALUES (?, ?)
       ON CONFLICT(twitch_id) DO UPDATE SET username = excluded.username`
    )
    .bind(userId, username)
    .run();
}

export async function grantPacks(
  db: D1Database,
  userId: string,
  quantity: number,
  source: string,
  tier: PackTier
): Promise<void> {
  if (quantity < 1) return;
  const statements = Array.from({ length: quantity }, () =>
    db.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, ?, ?)").bind(userId, source, tier)
  );
  await db.batch(statements);
}
