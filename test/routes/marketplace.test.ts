import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM marketplace_offer_items");
  await env.DB.exec("DELETE FROM marketplace_offers");
  await env.DB.exec("DELETE FROM user_cards");
  await env.DB.exec("DELETE FROM cards");
  await env.DB.exec("DELETE FROM users");

  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1"),
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "p1",
      "Pikachu",
      "common",
      "/cards/p1.png"
    ),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "c1",
      "Charizard",
      "epic",
      "/cards/c1.png"
    ),
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 3),
  ]);
});

it("creates an active offer and reserves the offered cards", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: number; status: string }>();

  const offer = await env.DB.prepare("SELECT creator_id, demand_card_id, status FROM marketplace_offers WHERE id = ?")
    .bind(id)
    .first<{ creator_id: string; demand_card_id: string; status: string }>();
  expect(offer).toEqual({ creator_id: "1", demand_card_id: "p1", status: "active" });

  const reserved = await env.DB.prepare("SELECT reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ reserved: number }>();
  expect(reserved?.reserved).toBe(2);
});

it("rejects an offer with no offered cards", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [] }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects an offer for more cards than the creator has available", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 99 }] }),
    },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects creating a 5th offer when the creator already has 4 active or accepted", async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'active')"
    ),
    env.DB.prepare(
      "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'active')"
    ),
    env.DB.prepare(
      "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'accepted')"
    ),
    env.DB.prepare(
      "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'accepted')"
    ),
  ]);
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  expect(res.status).toBe(409);
});

it("merges duplicate cardId entries in offerItems before validating", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        demandCardId: "p1",
        offerItems: [
          { cardId: "c1", quantity: 2 },
          { cardId: "c1", quantity: 2 },
        ],
      }),
    },
    env
  );
  expect(res.status).toBe(409); // 4 total > 3 available
});

it("rejects unauthenticated requests", async () => {
  const res = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
    env
  );
  expect(res.status).toBe(401);
});
