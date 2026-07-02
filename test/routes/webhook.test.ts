import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";

const SECRET = "test-eventsub-secret";

async function signBody(messageId: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(messageId + timestamp + body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM packs");
  await env.DB.exec("DELETE FROM users");
  env.TWITCH_EVENTSUB_SECRET = SECRET;
  env.TWITCH_REWARD_ID = "reward-1";
});

it("responds to webhook_callback_verification with the challenge", async () => {
  const body = JSON.stringify({ challenge: "abc123", subscription: {} });
  const messageId = "msg-1";
  const timestamp = new Date().toISOString();
  const signature = await signBody(messageId, timestamp, body);

  const res = await app.request(
    "/webhook/eventsub",
    {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": signature,
        "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
      },
    },
    env
  );

  expect(res.status).toBe(200);
  expect(await res.text()).toBe("abc123");
});

it("creates a pending pack on a matching reward redemption notification", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
    event: {
      user_id: "42",
      user_login: "mrklypp",
      user_name: "mrklypp",
      reward: { id: "reward-1" },
    },
  });
  const messageId = "msg-2";
  const timestamp = new Date().toISOString();
  const signature = await signBody(messageId, timestamp, body);

  const res = await app.request(
    "/webhook/eventsub",
    {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": signature,
        "Twitch-Eventsub-Message-Type": "notification",
      },
    },
    env
  );

  expect(res.status).toBe(200);
  const pack = await env.DB.prepare("SELECT user_id, opened_at FROM packs WHERE user_id = ?")
    .bind("42")
    .first<{ user_id: string; opened_at: string | null }>();
  expect(pack).toEqual({ user_id: "42", opened_at: null });
});

it("defaults new pack rows to source 'reward'", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
    event: {
      user_id: "42",
      user_login: "mrklypp",
      user_name: "mrklypp",
      reward: { id: "reward-1" },
    },
  });
  const messageId = "msg-source-1";
  const timestamp = new Date().toISOString();
  const signature = await signBody(messageId, timestamp, body);

  await app.request(
    "/webhook/eventsub",
    {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": signature,
        "Twitch-Eventsub-Message-Type": "notification",
      },
    },
    env
  );

  const pack = await env.DB.prepare("SELECT source FROM packs WHERE user_id = ?")
    .bind("42")
    .first<{ source: string }>();
  expect(pack?.source).toBe("reward");
});

it("rejects a notification with an invalid signature", async () => {
  const body = JSON.stringify({ event: { user_id: "42", reward: { id: "reward-1" } } });
  const res = await app.request(
    "/webhook/eventsub",
    {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": "msg-3",
        "Twitch-Eventsub-Message-Timestamp": new Date().toISOString(),
        "Twitch-Eventsub-Message-Signature": "sha256=wrong",
        "Twitch-Eventsub-Message-Type": "notification",
      },
    },
    env
  );
  expect(res.status).toBe(403);
});

it("ignores a notification for a different reward id", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
    event: { user_id: "99", user_login: "other", reward: { id: "some-other-reward" } },
  });
  const messageId = "msg-4";
  const timestamp = new Date().toISOString();
  const signature = await signBody(messageId, timestamp, body);

  const res = await app.request(
    "/webhook/eventsub",
    {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": signature,
        "Twitch-Eventsub-Message-Type": "notification",
      },
    },
    env
  );
  expect(res.status).toBe(200);
  const pack = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("99").first();
  expect(pack).toBeNull();
});
