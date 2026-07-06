import { Hono } from "hono";
import type { Env } from "../types";
import { verifyEventSubSignature } from "../lib/eventsub";
import { upsertUser, grantPacks } from "../lib/grants";

const webhook = new Hono<{ Bindings: Env }>();

interface PackGrantConfig {
  reward_quantity: number;
  bits_threshold: number;
  bits_quantity: number;
  sub_quantity: number;
  gift_sub_multiplier: number;
}

async function getPackGrantConfig(db: D1Database): Promise<PackGrantConfig> {
  const row = await db
    .prepare(
      "SELECT reward_quantity, bits_threshold, bits_quantity, sub_quantity, gift_sub_multiplier FROM pack_grant_config WHERE id = 1"
    )
    .first<PackGrantConfig>();
  return row!;
}

async function addBitsAndGetPackCount(
  db: D1Database,
  userId: string,
  bits: number,
  threshold: number,
  quantity: number
): Promise<number> {
  const row = await db
    .prepare("SELECT bits_balance FROM users WHERE twitch_id = ?")
    .bind(userId)
    .first<{ bits_balance: number }>();
  const balance = (row?.bits_balance ?? 0) + bits;
  await db
    .prepare("UPDATE users SET bits_balance = ? WHERE twitch_id = ?")
    .bind(balance % threshold, userId)
    .run();
  return Math.floor(balance / threshold) * quantity;
}

interface RewardRedemptionEvent {
  user_id: string;
  user_login: string;
  reward: { id: string };
}
interface CheerEvent {
  user_id?: string;
  user_login?: string;
  bits: number;
  is_anonymous: boolean;
}
interface SubscribeEvent {
  user_id: string;
  user_login: string;
  is_gift: boolean;
}
interface SubscriptionMessageEvent {
  user_id: string;
  user_login: string;
}
interface SubscriptionGiftEvent {
  user_id?: string;
  user_login?: string;
  total: number;
  is_anonymous: boolean;
}

webhook.post("/eventsub", async (c) => {
  const body = await c.req.text();
  const messageId = c.req.header("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = c.req.header("Twitch-Eventsub-Message-Timestamp") ?? "";
  const signature = c.req.header("Twitch-Eventsub-Message-Signature") ?? "";
  const messageType = c.req.header("Twitch-Eventsub-Message-Type") ?? "";

  const valid = await verifyEventSubSignature({
    secret: c.env.TWITCH_EVENTSUB_SECRET,
    messageId,
    timestamp,
    body,
    signatureHeader: signature,
  });
  if (!valid) return c.json({ error: "Invalid signature" }, 403);

  const payload = JSON.parse(body) as {
    challenge?: string;
    subscription?: { type: string };
    event?: Record<string, unknown>;
  };

  if (messageType === "webhook_callback_verification") {
    return c.text(payload.challenge ?? "", 200);
  }

  if (messageType !== "notification" || !payload.event) {
    return c.json({ ok: true }, 200);
  }

  const subscriptionType = payload.subscription?.type ?? "";
  const config = await getPackGrantConfig(c.env.DB);

  switch (subscriptionType) {
    case "channel.channel_points_custom_reward_redemption.add": {
      const event = payload.event as unknown as RewardRedemptionEvent;
      if (event.reward.id !== c.env.TWITCH_REWARD_ID) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      await grantPacks(c.env.DB, event.user_id, config.reward_quantity, "reward", "gratis");
      break;
    }
    case "channel.cheer": {
      const event = payload.event as unknown as CheerEvent;
      if (event.is_anonymous || !event.user_id) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login ?? event.user_id);
      const packs = await addBitsAndGetPackCount(
        c.env.DB,
        event.user_id,
        event.bits,
        config.bits_threshold,
        config.bits_quantity
      );
      await grantPacks(c.env.DB, event.user_id, packs, "bits", "apoyo");
      break;
    }
    case "channel.subscribe": {
      const event = payload.event as unknown as SubscribeEvent;
      if (event.is_gift) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      await grantPacks(c.env.DB, event.user_id, config.sub_quantity, "sub", "apoyo");
      break;
    }
    case "channel.subscription.message": {
      const event = payload.event as unknown as SubscriptionMessageEvent;
      await upsertUser(c.env.DB, event.user_id, event.user_login);
      await grantPacks(c.env.DB, event.user_id, config.sub_quantity, "sub", "apoyo");
      break;
    }
    case "channel.subscription.gift": {
      const event = payload.event as unknown as SubscriptionGiftEvent;
      if (event.is_anonymous || !event.user_id) break;
      await upsertUser(c.env.DB, event.user_id, event.user_login ?? event.user_id);
      await grantPacks(c.env.DB, event.user_id, event.total * config.gift_sub_multiplier, "gift_sub", "apoyo");
      break;
    }
  }

  return c.json({ ok: true }, 200);
});

export default webhook;
