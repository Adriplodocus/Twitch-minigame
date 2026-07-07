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

it("lists only the current user's offers, active and accepted", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'active')"),
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('2', 'p1', 'active')"),
  ]);
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers).toHaveLength(1);
});

it("includes offered card details in the mine listing", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{
    offers: { id: number; demand: { name: string }; offerItems: { name: string; quantity: number }[] }[];
  }>();
  const offer = json.offers.find((o) => o.id === id)!;
  expect(offer.demand.name).toBe("Pikachu");
  expect(offer.offerItems).toEqual([expect.objectContaining({ name: "Charizard", quantity: 2 })]);
});

it("cancels an active offer and releases the reservation", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cancelRes = await app.request(`/api/marketplace/offers/${id}/cancel`, { method: "POST", headers: { Cookie: cookie } }, env);
  expect(cancelRes.status).toBe(200);

  const offer = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(id).first();
  expect(offer).toBeNull();
  const reserved = await env.DB.prepare("SELECT reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ reserved: number }>();
  expect(reserved?.reserved).toBe(0);
});

it("rejects cancelling an offer that belongs to someone else", async () => {
  const cookieCreator = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookieCreator, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cookieOther = await sessionCookie("2", "viewer2");
  const res = await app.request(`/api/marketplace/offers/${id}/cancel`, { method: "POST", headers: { Cookie: cookieOther } }, env);
  expect(res.status).toBe(404);
});

it("rejects cancelling an already-accepted offer", async () => {
  await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'accepted')"
  ).run();
  const offer = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE creator_id = '1'").first<{ id: number }>();
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(`/api/marketplace/offers/${offer!.id}/cancel`, { method: "POST", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(409);
});

it("deletes an accepted offer without touching card quantities", async () => {
  await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id, status) VALUES ('1', 'p1', 'accepted')"
  ).run();
  const offer = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE creator_id = '1'").first<{ id: number }>();
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(`/api/marketplace/offers/${offer!.id}`, { method: "DELETE", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(offer!.id).first();
  expect(row).toBeNull();
});

it("rejects deleting an offer that is still active", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();
  const res = await app.request(`/api/marketplace/offers/${id}`, { method: "DELETE", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(409);
});

it("silently expires an active offer older than 7 days and releases its reservation", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();
  await env.DB.prepare("UPDATE marketplace_offers SET created_at = datetime('now', '-8 days') WHERE id = ?")
    .bind(id)
    .run();

  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === id)).toBeUndefined();

  const reserved = await env.DB.prepare("SELECT reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ reserved: number }>();
  expect(reserved?.reserved).toBe(0);
});

it("does not expire an active offer younger than 7 days", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 1 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === id)).toBeDefined();
});

it("only releases the reservation once when the expiry sweep races on the same offer", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ demandCardId: "p1", offerItems: [{ cardId: "c1", quantity: 2 }] }),
    },
    env
  );
  const { id } = await createRes.json<{ id: number }>();
  await env.DB.prepare("UPDATE marketplace_offers SET created_at = datetime('now', '-8 days') WHERE id = ?")
    .bind(id)
    .run();

  // Simulate two concurrent pollers both triggering the expiry sweep for the same offer.
  const [res1, res2] = await Promise.all([
    app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env),
    app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env),
  ]);
  expect(res1.status).toBe(200);
  expect(res2.status).toBe(200);

  const offer = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(id).first();
  expect(offer).toBeNull();

  const items = await env.DB.prepare("SELECT * FROM marketplace_offer_items WHERE offer_id = ?").bind(id).all();
  expect(items.results).toHaveLength(0);

  const reserved = await env.DB.prepare("SELECT reserved FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ reserved: number }>();
  // Correctness invariants that hold regardless of interleaving (unlike a plain "equals 0", which a
  // lucky interleaving could satisfy even with a subtly broken release): reserved must never go
  // negative (a double release), the offer row must be fully gone, and its items must be cleaned up.
  // Started at 2 after the offer reserved it, so a single release lands exactly at 0 here.
  expect(reserved?.reserved).toBeGreaterThanOrEqual(0);
  expect(reserved?.reserved).toBe(0);
});

it("silently expires an accepted offer older than 7 days without touching card quantities", async () => {
  await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id, status, accepted_at) VALUES ('1', 'p1', 'accepted', datetime('now', '-8 days'))"
  ).run();
  const offer = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE creator_id = '1'").first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === offer!.id)).toBeUndefined();
});

it("expires and deletes an active offer that has zero items (e.g. an interrupted create)", async () => {
  // Bypass the normal create-offer route (which always requires >=1 item) to reproduce the state
  // reachable if POST /offers is interrupted between inserting the offer row and batching its items.
  await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id, status, created_at) VALUES ('1', 'p1', 'active', datetime('now', '-8 days'))"
  ).run();
  const offer = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE creator_id = '1'").first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === offer!.id)).toBeUndefined();

  const row = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(offer!.id).first();
  expect(row).toBeNull();
});
