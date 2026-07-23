import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM trade_offers");
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

it("creates a demand", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: number }>();

  const row = await env.DB.prepare("SELECT creator_id, demand_card_id FROM marketplace_offers WHERE id = ?")
    .bind(id)
    .first<{ creator_id: string; demand_card_id: string }>();
  expect(row).toEqual({ creator_id: "1", demand_card_id: "p1" });
});

it("rejects a demand for a card that doesn't exist", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "nope" }) },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects a 5th demand once the creator already has 4", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1')"),
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1')"),
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1')"),
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1')"),
  ]);
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects unauthenticated requests", async () => {
  const res = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  expect(res.status).toBe(401);
});

it("lists only the current user's demands", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1')"),
    env.DB.prepare("INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('2', 'p1')"),
  ]);
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ offers: { id: number; demand: { name: string } }[] }>();
  expect(json.offers).toHaveLength(1);
  expect(json.offers[0].demand.name).toBe("Pikachu");
});

it("cancels a demand", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const res = await app.request(`/api/marketplace/offers/${id}/cancel`, { method: "POST", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);

  const row = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(id).first();
  expect(row).toBeNull();
});

it("cancelling a demand declines its pending responses", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id: demandId } = await createRes.json<{ id: number }>();
  const { id: offerId } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('2', '1', ?) RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();

  await app.request(`/api/marketplace/offers/${demandId}/cancel`, { method: "POST", headers: { Cookie: cookie } }, env);

  const offerRow = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string }>();
  expect(offerRow?.status).toBe("declined");
});

it("rejects cancelling someone else's demand", async () => {
  const cookieCreator = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookieCreator, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cookieOther = await sessionCookie("2", "viewer2");
  const res = await app.request(`/api/marketplace/offers/${id}/cancel`, { method: "POST", headers: { Cookie: cookieOther } }, env);
  expect(res.status).toBe(404);
});

it("silently expires a demand older than 7 days and declines its pending responses", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id: demandId } = await createRes.json<{ id: number }>();
  const { id: offerId } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('2', '1', ?) RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();
  await env.DB.prepare("UPDATE marketplace_offers SET created_at = datetime('now', '-8 days') WHERE id = ?")
    .bind(demandId)
    .run();

  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === demandId)).toBeUndefined();

  const offerRow = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerId)
    .first<{ status: string }>();
  expect(offerRow?.status).toBe("declined");
});

it("does not expire a demand younger than 7 days", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const res = await app.request("/api/marketplace/offers/mine", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: { id: number }[] }>();
  expect(json.offers.find((o) => o.id === id)).toBeDefined();
});

it("excludes the viewer's own demands from the public listing", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const res = await app.request("/api/marketplace/offers", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ offers: unknown[] }>();
  expect(json.offers).toHaveLength(0);
});

it("shows another user's demand with the viewer's owned quantity of the demanded card", async () => {
  const cookieCreator = await sessionCookie("2", "viewer2");
  await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookieCreator, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "c1" }) },
    env
  );

  const cookieViewer = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers", { headers: { Cookie: cookieViewer } }, env);
  const json = await res.json<{
    offers: { creatorUsername: string; demand: { cardId: string; viewerQuantity: number } }[];
  }>();
  expect(json.offers).toHaveLength(1);
  expect(json.offers[0].creatorUsername).toBe("viewer2");
  expect(json.offers[0].demand.viewerQuantity).toBe(3); // viewer1 owns 3 of c1
});

it("filters the public listing by demand card name", async () => {
  const cookieCreator = await sessionCookie("2", "viewer2");
  await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookieCreator, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );

  const cookieViewer = await sessionCookie("1", "viewer1");
  const matchRes = await app.request("/api/marketplace/offers?demandQuery=pika", { headers: { Cookie: cookieViewer } }, env);
  expect((await matchRes.json<{ offers: unknown[] }>()).offers).toHaveLength(1);

  const noMatchRes = await app.request("/api/marketplace/offers?demandQuery=zzz", { headers: { Cookie: cookieViewer } }, env);
  expect((await noMatchRes.json<{ offers: unknown[] }>()).offers).toHaveLength(0);
});

it("paginates the public listing 6 per page, newest first", async () => {
  const userStatements = [];
  for (let i = 0; i < 8; i++) {
    userStatements.push(
      env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind(`page-user-${i}`, `pageuser${i}`)
    );
  }
  await env.DB.batch(userStatements);

  const offerStatements = [];
  for (let i = 0; i < 8; i++) {
    offerStatements.push(
      env.DB.prepare(
        "INSERT INTO marketplace_offers (creator_id, demand_card_id, created_at) VALUES (?, 'p1', datetime('now', ?))"
      ).bind(`page-user-${i}`, `-${i} minutes`)
    );
  }
  await env.DB.batch(offerStatements);

  const cookieViewer = await sessionCookie("1", "viewer1");
  const page1Res = await app.request("/api/marketplace/offers?page=1", { headers: { Cookie: cookieViewer } }, env);
  const page1 = await page1Res.json<{ offers: { creatorUsername: string }[]; totalCount: number; pageSize: number }>();
  expect(page1.pageSize).toBe(6);
  expect(page1.totalCount).toBe(8);
  expect(page1.offers).toHaveLength(6);
  expect(page1.offers[0].creatorUsername).toBe("pageuser0");

  const page2Res = await app.request("/api/marketplace/offers?page=2", { headers: { Cookie: cookieViewer } }, env);
  const page2 = await page2Res.json<{ offers: { creatorUsername: string }[] }>();
  expect(page2.offers).toHaveLength(2);
  expect(page2.offers[1].creatorUsername).toBe("pageuser7");
});

it("gets a single demand by id for the trade.html prefill", async () => {
  const cookieCreator = await sessionCookie("2", "viewer2");
  const createRes = await app.request(
    "/api/marketplace/offers",
    { method: "POST", headers: { Cookie: cookieCreator, "Content-Type": "application/json" }, body: JSON.stringify({ demandCardId: "p1" }) },
    env
  );
  const { id } = await createRes.json<{ id: number }>();

  const cookieViewer = await sessionCookie("1", "viewer1");
  const res = await app.request(`/api/marketplace/offers/${id}`, { headers: { Cookie: cookieViewer } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ id: number; creatorUsername: string; demand: { cardId: string; name: string } }>();
  expect(json).toEqual({ id, creatorUsername: "viewer2", demand: { cardId: "p1", name: "Pikachu", rarity: "common", imagePath: "/cards/p1.png" } });
});

it("404s getting a demand that doesn't exist", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/marketplace/offers/9999", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(404);
});
