import { Hono } from "hono";
import type { Env } from "../types";
import { verifyEventSubSignature } from "../lib/eventsub";

const webhook = new Hono<{ Bindings: Env }>();

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
    event?: { user_id: string; user_login: string; user_name: string; reward: { id: string } };
  };

  if (messageType === "webhook_callback_verification") {
    return c.text(payload.challenge ?? "", 200);
  }

  if (messageType === "notification" && payload.event) {
    const { user_id, user_login, reward } = payload.event;
    if (reward.id !== c.env.TWITCH_REWARD_ID) return c.json({ ok: true }, 200);

    await c.env.DB.prepare(
      `INSERT INTO users (twitch_id, username) VALUES (?, ?)
       ON CONFLICT(twitch_id) DO UPDATE SET username = excluded.username`
    )
      .bind(user_id, user_login)
      .run();
    await c.env.DB.prepare("INSERT INTO packs (user_id) VALUES (?)").bind(user_id).run();
    return c.json({ ok: true }, 200);
  }

  return c.json({ ok: true }, 200);
});

export default webhook;
