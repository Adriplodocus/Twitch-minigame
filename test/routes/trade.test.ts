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

it("auto-expires a pending offer older than 7 days on list", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  await env.DB.prepare("UPDATE trade_offers SET created_at = datetime('now', '-8 days') WHERE id = ?")
    .bind(offerId)
    .run();

  const res = await app.request("/api/trade/offers", { headers: { Cookie: cookieTo } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ received: { id: number; status: string; autoExpired: boolean }[] }>();
  expect(json.received).toEqual([expect.objectContaining({ id: offerId, status: "declined", autoExpired: true })]);

  const row = await env.DB.prepare("SELECT status, auto_expired FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string; auto_expired: number }>();
  expect(row).toEqual({ status: "declined", auto_expired: 1 });
});

it("does not expire a pending offer younger than 7 days", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const res = await app.request("/api/trade/offers", { headers: { Cookie: cookieFrom } }, env);
  const json = await res.json<{ sent: { id: number; status: string }[] }>();
  expect(json.sent.find((o) => o.id === offerId)?.status).toBe("pending");
});

it("accepts an offer and swaps card ownership atomically", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");

  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({
        toUsername: "viewer2",
        offerCards: [{ cardId: "c1", quantity: 1 }],
        requestCards: [{ cardId: "c1", quantity: 1 }],
      }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const acceptRes = await app.request(
    `/api/trade/offers/${offerId}/accept`,
    { method: "POST", headers: { Cookie: cookieTo } },
    env
  );
  expect(acceptRes.status).toBe(200);

  const offer = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string }>();
  expect(offer?.status).toBe("accepted");

  const fromQty = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  const toQty = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("2", "c1")
    .first<{ quantity: number }>();
  expect(fromQty?.quantity).toBe(3);
  expect(toQty?.quantity).toBe(1);
});

it("rejects accept from a user who is not the offer recipient", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const res = await app.request(
    `/api/trade/offers/${offerId}/accept`,
    { method: "POST", headers: { Cookie: cookieFrom } },
    env
  );
  expect(res.status).toBe(404);
});

it("declines an offer", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const res = await app.request(
    `/api/trade/offers/${offerId}/decline`,
    { method: "POST", headers: { Cookie: cookieTo } },
    env
  );
  expect(res.status).toBe(200);
  const offer = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string }>();
  expect(offer?.status).toBe("declined");
});

it("cancels an offer", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const res = await app.request(
    `/api/trade/offers/${offerId}/cancel`,
    { method: "POST", headers: { Cookie: cookieFrom } },
    env
  );
  expect(res.status).toBe(200);
  const offer = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string }>();
  expect(offer?.status).toBe("cancelled");
});

it("rejects deleting a pending offer", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const res = await app.request(
    `/api/trade/offers/${offerId}?side=sent`,
    { method: "DELETE", headers: { Cookie: cookieFrom } },
    env
  );
  expect(res.status).toBe(409);
});

it("deletes a finished offer only from the deleting side's view", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();
  await app.request(`/api/trade/offers/${offerId}/decline`, { method: "POST", headers: { Cookie: cookieTo } }, env);

  const deleteRes = await app.request(
    `/api/trade/offers/${offerId}?side=sent`,
    { method: "DELETE", headers: { Cookie: cookieFrom } },
    env
  );
  expect(deleteRes.status).toBe(200);

  const fromView = await app.request("/api/trade/offers", { headers: { Cookie: cookieFrom } }, env);
  const fromJson = await fromView.json<{ sent: { id: number }[] }>();
  expect(fromJson.sent.find((o) => o.id === offerId)).toBeUndefined();

  const toView = await app.request("/api/trade/offers", { headers: { Cookie: cookieTo } }, env);
  const toJson = await toView.json<{ received: { id: number }[] }>();
  expect(toJson.received.find((o) => o.id === offerId)).toBeDefined();
});

it("deletes a finished offer from the receiver's view without hiding it from the sender", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();
  await app.request(`/api/trade/offers/${offerId}/decline`, { method: "POST", headers: { Cookie: cookieTo } }, env);

  const deleteRes = await app.request(
    `/api/trade/offers/${offerId}?side=received`,
    { method: "DELETE", headers: { Cookie: cookieTo } },
    env
  );
  expect(deleteRes.status).toBe(200);

  const toView = await app.request("/api/trade/offers", { headers: { Cookie: cookieTo } }, env);
  const toJson = await toView.json<{ received: { id: number }[] }>();
  expect(toJson.received.find((o) => o.id === offerId)).toBeUndefined();

  const fromView = await app.request("/api/trade/offers", { headers: { Cookie: cookieFrom } }, env);
  const fromJson = await fromView.json<{ sent: { id: number }[] }>();
  expect(fromJson.sent.find((o) => o.id === offerId)).toBeDefined();
});

it("deletes an auto-expired offer the same way as a normally-declined one", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  await env.DB.prepare("UPDATE trade_offers SET created_at = datetime('now', '-8 days') WHERE id = ?")
    .bind(offerId)
    .run();
  await app.request("/api/trade/offers", { headers: { Cookie: cookieTo } }, env);

  const deleteRes = await app.request(
    `/api/trade/offers/${offerId}?side=sent`,
    { method: "DELETE", headers: { Cookie: cookieFrom } },
    env
  );
  expect(deleteRes.status).toBe(200);
});

it("rejects deleting an offer the user isn't a participant of", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();
  await app.request(`/api/trade/offers/${offerId}/decline`, { method: "POST", headers: { Cookie: cookieTo } }, env);

  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("3", "viewer3").run();
  const cookieOther = await sessionCookie("3", "viewer3");

  const res = await app.request(
    `/api/trade/offers/${offerId}?side=received`,
    { method: "DELETE", headers: { Cookie: cookieOther } },
    env
  );
  expect(res.status).toBe(404);
});

it("deletes a self-trade offer from the receiver's view without also hiding it from the sender's view", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer1", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();
  await app.request(`/api/trade/offers/${offerId}/cancel`, { method: "POST", headers: { Cookie: cookie } }, env);

  const deleteRes = await app.request(
    `/api/trade/offers/${offerId}?side=received`,
    { method: "DELETE", headers: { Cookie: cookie } },
    env
  );
  expect(deleteRes.status).toBe(200);

  const view = await app.request("/api/trade/offers", { headers: { Cookie: cookie } }, env);
  const json = await view.json<{ sent: { id: number }[]; received: { id: number }[] }>();
  expect(json.received.find((o) => o.id === offerId)).toBeUndefined();
  expect(json.sent.find((o) => o.id === offerId)).toBeDefined();
});

it("rejects deleting without a valid side query param", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();
  await app.request(`/api/trade/offers/${offerId}/cancel`, { method: "POST", headers: { Cookie: cookie } }, env);

  const res = await app.request(`/api/trade/offers/${offerId}`, { method: "DELETE", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(400);
});

it("counts only received pending offers not hidden by the receiver", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");

  const zeroRes = await app.request("/api/trade/offers/pending-count", { headers: { Cookie: cookieTo } }, env);
  expect((await zeroRes.json<{ count: number }>()).count).toBe(0);

  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  const oneRes = await app.request("/api/trade/offers/pending-count", { headers: { Cookie: cookieTo } }, env);
  expect((await oneRes.json<{ count: number }>()).count).toBe(1);

  const senderRes = await app.request("/api/trade/offers/pending-count", { headers: { Cookie: cookieFrom } }, env);
  expect((await senderRes.json<{ count: number }>()).count).toBe(0);

  await app.request(`/api/trade/offers/${offerId}/decline`, { method: "POST", headers: { Cookie: cookieTo } }, env);
  const afterDeclineRes = await app.request("/api/trade/offers/pending-count", { headers: { Cookie: cookieTo } }, env);
  expect((await afterDeclineRes.json<{ count: number }>()).count).toBe(0);
});

it("excludes an offer older than 7 days from pending-count without first loading the offers list", async () => {
  const cookieFrom = await sessionCookie("1", "viewer1");
  const cookieTo = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/trade/offers",
    {
      method: "POST",
      headers: { Cookie: cookieFrom, "Content-Type": "application/json" },
      body: JSON.stringify({ toUsername: "viewer2", offerCards: [{ cardId: "c1", quantity: 1 }], requestCards: [] }),
    },
    env
  );
  const { id: offerId } = await createRes.json<{ id: number }>();

  await env.DB.prepare("UPDATE trade_offers SET created_at = datetime('now', '-8 days') WHERE id = ?")
    .bind(offerId)
    .run();

  const countRes = await app.request("/api/trade/offers/pending-count", { headers: { Cookie: cookieTo } }, env);
  expect((await countRes.json<{ count: number }>()).count).toBe(0);
});
