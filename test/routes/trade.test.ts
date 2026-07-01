// test/routes/trade.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM trade_items");
  await env.DB.exec("DELETE FROM trade_offers");
  await env.DB.exec("DELETE FROM user_cards");
  await env.DB.exec("DELETE FROM cards");
  await env.DB.exec("DELETE FROM users");

  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1"),
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "c1",
      "Common Card",
      "common",
      "/cards/c1.png"
    ),
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 3),
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("2", "c1", 1),
  ]);
});

it("looks up another user's public collection", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/trade/users/viewer2", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ username: string; cards: { id: string; quantity: number }[] }>();
  expect(json.username).toBe("viewer2");
  expect(json.cards.find((c) => c.id === "c1")?.quantity).toBe(1);
});

it("creates a pending trade offer", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [{ cardId: "c1", quantity: 1 }],
      }),
    },
    env
  );
  expect(res.status).toBe(201);

  const offer = await env.DB.prepare("SELECT from_user, to_user, status FROM trade_offers").first<{
    from_user: string;
    to_user: string;
    status: string;
  }>();
  expect(offer).toEqual({ from_user: "1", to_user: "2", status: "pending" });
});

it("rejects an offer for more cards than the sender owns", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 99 }],
        requestCards: [],
      }),
    },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects an offer when duplicate cardId entries combine to exceed owned quantity", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [
          { cardId: "c1", quantity: 2 },
          { cardId: "c1", quantity: 2 },
        ],
        requestCards: [],
      }),
    },
    env
  );
  expect(res.status).toBe(409);
});

it("lists offers sent and received by the current user", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [{ cardId: "c1", quantity: 1 }],
      }),
    },
    env
  );

  const res = await app.request("/api/trade/offers", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ sent: unknown[]; received: unknown[] }>();
  expect(json.sent).toHaveLength(1);
  expect(json.received).toHaveLength(0);
});
