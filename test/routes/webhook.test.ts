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
  await env.DB.exec(
    "UPDATE pack_grant_config SET reward_quantity = 1, bits_threshold = 200, bits_quantity = 1, sub_quantity = 1, gift_sub_multiplier = 1 WHERE id = 1"
  );
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

  const pack = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("42")
    .first<{ source: string; tier: string }>();
  expect(pack?.source).toBe("reward");
  expect(pack?.tier).toBe("gratis");
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

it("accumulates bits below the threshold without granting a pack", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.cheer" },
    event: { user_id: "42", user_login: "mrklypp", bits: 150, is_anonymous: false },
  });
  const messageId = "msg-cheer-1";
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
  const pack = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("42").first();
  expect(pack).toBeNull();
  const user = await env.DB.prepare("SELECT bits_balance FROM users WHERE twitch_id = ?")
    .bind("42")
    .first<{ bits_balance: number }>();
  expect(user?.bits_balance).toBe(150);
});

it("grants a support pack once accumulated bits cross 200 and keeps the remainder", async () => {
  await env.DB.prepare(`INSERT INTO users (twitch_id, username, bits_balance) VALUES (?, ?, ?)`)
    .bind("42", "mrklypp", 150)
    .run();

  const body = JSON.stringify({
    subscription: { type: "channel.cheer" },
    event: { user_id: "42", user_login: "mrklypp", bits: 100, is_anonymous: false },
  });
  const messageId = "msg-cheer-2";
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

  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("42")
    .all<{ source: string; tier: string }>();
  expect(packs.results).toEqual([{ source: "bits", tier: "apoyo" }]);
  const user = await env.DB.prepare("SELECT bits_balance FROM users WHERE twitch_id = ?")
    .bind("42")
    .first<{ bits_balance: number }>();
  expect(user?.bits_balance).toBe(50);
});

it("grants multiple packs when a single cheer crosses the threshold more than once", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.cheer" },
    event: { user_id: "42", user_login: "mrklypp", bits: 450, is_anonymous: false },
  });
  const messageId = "msg-cheer-3";
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

  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("42")
    .all<{ source: string; tier: string }>();
  expect(packs.results).toHaveLength(2);
  packs.results!.forEach((p) => expect(p).toEqual({ source: "bits", tier: "apoyo" }));
  const user = await env.DB.prepare("SELECT bits_balance FROM users WHERE twitch_id = ?")
    .bind("42")
    .first<{ bits_balance: number }>();
  expect(user?.bits_balance).toBe(50);
});

it("ignores an anonymous cheer", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.cheer" },
    event: { user_id: "42", user_login: "mrklypp", bits: 500, is_anonymous: true },
  });
  const messageId = "msg-cheer-4";
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
  const user = await env.DB.prepare("SELECT * FROM users WHERE twitch_id = ?").bind("42").first();
  expect(user).toBeNull();
});

it("grants a support pack on a new (non-gift) subscription", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.subscribe" },
    event: { user_id: "42", user_login: "mrklypp", is_gift: false },
  });
  const messageId = "msg-sub-1";
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

  const pack = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("42")
    .first<{ source: string; tier: string }>();
  expect(pack).toEqual({ source: "sub", tier: "apoyo" });
});

it("does not grant a pack to the recipient of a gifted subscription", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.subscribe" },
    event: { user_id: "77", user_login: "recipient", is_gift: true },
  });
  const messageId = "msg-sub-2";
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

  const pack = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("77").first();
  expect(pack).toBeNull();
});

it("grants a support pack on a subscription renewal message", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.subscription.message" },
    event: { user_id: "42", user_login: "mrklypp", cumulative_months: 3 },
  });
  const messageId = "msg-resub-1";
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

  const pack = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("42")
    .first<{ source: string; tier: string }>();
  expect(pack).toEqual({ source: "sub", tier: "apoyo" });
});

it("grants total packs to the gifter on a subscription gift event", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.subscription.gift" },
    event: { user_id: "55", user_login: "generous", total: 3, is_anonymous: false },
  });
  const messageId = "msg-gift-1";
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

  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("55")
    .all<{ source: string; tier: string }>();
  expect(packs.results).toHaveLength(3);
  packs.results!.forEach((p) => expect(p).toEqual({ source: "gift_sub", tier: "apoyo" }));
});

it("ignores an anonymous subscription gift", async () => {
  const body = JSON.stringify({
    subscription: { type: "channel.subscription.gift" },
    event: { total: 5, is_anonymous: true },
  });
  const messageId = "msg-gift-2";
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
  const packs = await env.DB.prepare("SELECT * FROM packs").all();
  expect(packs.results).toHaveLength(0);
});

it("respects a configured reward_quantity greater than 1", async () => {
  await env.DB.prepare("UPDATE pack_grant_config SET reward_quantity = 3 WHERE id = 1").run();
  const body = JSON.stringify({
    subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
    event: { user_id: "42", user_login: "mrklypp", reward: { id: "reward-1" } },
  });
  const messageId = "msg-cfg-reward";
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

  const packs = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("42").all();
  expect(packs.results).toHaveLength(3);
});

it("respects a configured bits_threshold and bits_quantity", async () => {
  await env.DB.prepare("UPDATE pack_grant_config SET bits_threshold = 100, bits_quantity = 2 WHERE id = 1").run();
  const body = JSON.stringify({
    subscription: { type: "channel.cheer" },
    event: { user_id: "42", user_login: "mrklypp", bits: 250, is_anonymous: false },
  });
  const messageId = "msg-cfg-bits";
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

  // 250 bits / 100 threshold = 2 crossings * 2 quantity = 4 packs, remainder 50
  const packs = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("42").all();
  expect(packs.results).toHaveLength(4);
  const user = await env.DB.prepare("SELECT bits_balance FROM users WHERE twitch_id = ?")
    .bind("42")
    .first<{ bits_balance: number }>();
  expect(user?.bits_balance).toBe(50);
});

it("respects a configured sub_quantity", async () => {
  await env.DB.prepare("UPDATE pack_grant_config SET sub_quantity = 5 WHERE id = 1").run();
  const body = JSON.stringify({
    subscription: { type: "channel.subscribe" },
    event: { user_id: "42", user_login: "mrklypp", is_gift: false },
  });
  const messageId = "msg-cfg-sub";
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

  const packs = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("42").all();
  expect(packs.results).toHaveLength(5);
});

it("respects a configured gift_sub_multiplier", async () => {
  await env.DB.prepare("UPDATE pack_grant_config SET gift_sub_multiplier = 2 WHERE id = 1").run();
  const body = JSON.stringify({
    subscription: { type: "channel.subscription.gift" },
    event: { user_id: "55", user_login: "generous", total: 3, is_anonymous: false },
  });
  const messageId = "msg-cfg-gift";
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

  // 3 gifted subs * multiplier 2 = 6 packs
  const packs = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("55").all();
  expect(packs.results).toHaveLength(6);
});
