// test/routes/collection.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM pack_cards");
  await env.DB.exec("DELETE FROM user_cards");
  await env.DB.exec("DELETE FROM packs");
  await env.DB.exec("DELETE FROM cards");
  await env.DB.exec("DELETE FROM users");

  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "c1",
      "Common Card",
      "common",
      "/cards/c1.png"
    ),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "r1",
      "Rare Card",
      "rare",
      "/cards/r1.png"
    ),
  ]);
});

it("requires auth", async () => {
  const res = await app.request("/api/collection", {}, env);
  expect(res.status).toBe(401);
});

it("shows quantity minus reserved as the available amount", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity, reserved) VALUES (?, ?, ?, ?)").bind(
      "1",
      "c1",
      3,
      1
    ),
  ]);
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/collection", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ cards: { id: string; quantity: number }[] }>();
  expect(json.cards.find((c) => c.id === "c1")?.quantity).toBe(2);
});

it("lists all catalog cards with owned quantities and pending packs", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)")
    .bind("1", "c1", 2)
    .run();
  await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?)").bind("1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/collection", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{
    cards: { id: string; quantity: number; generation: number }[];
    pendingPacks: { id: number }[];
  }>();

  const c1 = json.cards.find((c) => c.id === "c1");
  const r1 = json.cards.find((c) => c.id === "r1");
  expect(c1?.quantity).toBe(2);
  expect(r1?.quantity).toBe(0);
  expect(c1?.generation).toBe(1);
  expect(json.pendingPacks).toHaveLength(1);
});

it("includes the tier of each pending pack", async () => {
  await env.DB.prepare("INSERT INTO packs (user_id, tier) VALUES (?, 'apoyo')").bind("1").run();
  await env.DB.prepare("INSERT INTO packs (user_id, tier) VALUES (?, 'gratis')").bind("1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/collection", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ pendingPacks: { tier: string }[] }>();

  const tiers = json.pendingPacks.map((p) => p.tier).sort();
  expect(tiers).toEqual(["apoyo", "gratis"]);
});

it("includes the user's coin balance", async () => {
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(250, "1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/collection", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(250);
});

it("defaults coin balance to 0 for a brand new user", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/collection", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(0);
});

it("opens a pending pack and grants 10 cards", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string }[] }>();
  expect(json.cards).toHaveLength(10);

  const pack = await env.DB.prepare("SELECT opened_at FROM packs WHERE id = ?")
    .bind(packResult!.id)
    .first<{ opened_at: string | null }>();
  expect(pack?.opened_at).not.toBeNull();
});

it("includes the caller's coin balance in the open response", async () => {
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(300, "1").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    },
    env
  );
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(300);
});

it("debits 150 coins and opens the pack when boost is requested with enough coins", async () => {
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(200, "1").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1, boost: true }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string }[]; coins: number }>();
  expect(json.cards).toHaveLength(10);
  expect(json.coins).toBe(50);

  const pack = await env.DB.prepare("SELECT opened_at FROM packs WHERE id = ?")
    .bind(packResult!.id)
    .first<{ opened_at: string | null }>();
  expect(pack?.opened_at).not.toBeNull();
});

it("rejects boosting without enough coins and leaves the pack unopened", async () => {
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(100, "1").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1, boost: true }),
    },
    env
  );
  expect(res.status).toBe(400);
  const json = await res.json<{ error: string }>();
  expect(json.error).toBe("Not enough coins");

  const pack = await env.DB.prepare("SELECT opened_at FROM packs WHERE id = ?")
    .bind(packResult!.id)
    .first<{ opened_at: string | null }>();
  expect(pack?.opened_at).toBeNull();
  const user = await env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?").bind("1").first<{ coins: number }>();
  expect(user?.coins).toBe(100);
});

it("does not touch coins when boost is omitted", async () => {
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(300, "1").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    },
    env
  );
  const user = await env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?").bind("1").first<{ coins: number }>();
  expect(user?.coins).toBe(300);
});

it("only draws cards from the requested generation", async () => {
  await env.DB.prepare("UPDATE cards SET generation = 2 WHERE id = 'r1'").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 2 }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string }[] }>();
  expect(json.cards.length).toBeGreaterThan(0);
  expect(json.cards.every((c) => c.id === "r1")).toBe(true);
});

it("rejects opening a pack with an invalid generation", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 99 }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects opening a pack with a null request body", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(null),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects opening a pack that belongs to another user", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("2")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(404);
});

it("rejects opening an already-opened pack", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();
  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    },
    env
  );

  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(409);
});

it("resolves a double-open race with exactly one success, one 409, and one set of cards", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const requestBody = {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ generation: 1 }),
  } as const;

  const [res1, res2] = await Promise.all([
    app.request(`/api/collection/packs/${packResult!.id}/open`, requestBody, env),
    app.request(`/api/collection/packs/${packResult!.id}/open`, requestBody, env),
  ]);

  const statuses = [res1.status, res2.status].sort();
  expect(statuses).toEqual([200, 409]);

  const packCards = await env.DB.prepare("SELECT COUNT(*) AS count FROM pack_cards WHERE pack_id = ?")
    .bind(packResult!.id)
    .first<{ count: number }>();
  expect(packCards?.count).toBe(10);
});

it("resolves a boosted double-open race with exactly one 150-coin debit", async () => {
  // Enough coins to cover two boost debits, so the race is decided by the pack claim
  // (not by one request failing on insufficient funds) — the loser must be refunded.
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(500, "1").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const requestBody = {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ generation: 1, boost: true }),
  } as const;

  const [res1, res2] = await Promise.all([
    app.request(`/api/collection/packs/${packResult!.id}/open`, requestBody, env),
    app.request(`/api/collection/packs/${packResult!.id}/open`, requestBody, env),
  ]);

  const statuses = [res1.status, res2.status].sort();
  expect(statuses).toEqual([200, 409]);

  const packCards = await env.DB.prepare("SELECT COUNT(*) AS count FROM pack_cards WHERE pack_id = ?")
    .bind(packResult!.id)
    .first<{ count: number }>();
  expect(packCards?.count).toBe(10);

  // 500 - 150 (single net boost debit, the losing request's debit must have been refunded)
  const user = await env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?").bind("1").first<{ coins: number }>();
  expect(user?.coins).toBe(350);
});

it("opens a pack using its stored tier without erroring", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id, tier) VALUES (?, 'apoyo') RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string }[] }>();
  expect(json.cards).toHaveLength(10);
});

it("marks an opened pack as broadcast", async () => {
  const packResult = await env.DB.prepare(
    "INSERT INTO packs (user_id, opened_at) VALUES (?, CURRENT_TIMESTAMP) RETURNING id"
  )
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/broadcast`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(200);

  const pack = await env.DB.prepare("SELECT broadcast_at FROM packs WHERE id = ?")
    .bind(packResult!.id)
    .first<{ broadcast_at: string | null }>();
  expect(pack?.broadcast_at).not.toBeNull();
});

it("rejects broadcasting a pack that hasn't been opened yet", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/broadcast`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects broadcasting a pack that belongs to another user", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2").run();
  const packResult = await env.DB.prepare(
    "INSERT INTO packs (user_id, opened_at) VALUES (?, CURRENT_TIMESTAMP) RETURNING id"
  )
    .bind("2")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/broadcast`,
    { method: "POST", headers: { Cookie: cookie } },
    env
  );
  expect(res.status).toBe(404);
});

it("discards a duplicate card and credits coins by rarity", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 3).run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ ok: true; coins: number }>();
  expect(json.coins).toBe(5); // common discard value

  const owned = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  expect(owned?.quantity).toBe(2);
});

it("credits the higher shiny discard value for a shiny card id", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)")
    .bind("1", "c1-shiny", 2)
    .run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1-shiny" }) },
    env
  );
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(40); // common shiny discard value
});

it("rejects discarding the only copy of a card", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 1).run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(409);

  const owned = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  expect(owned?.quantity).toBe(1);
});

it("rejects discarding a reserved copy that would drop available quantity to 0", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity, reserved) VALUES (?, ?, ?, ?)")
    .bind("1", "c1", 2, 1)
    .run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects discarding a card the user doesn't own", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects discarding an unknown cardId", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "nope" }) },
    env
  );
  expect(res.status).toBe(404);
});

it("rejects a discard request with a null body", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(null) },
    env
  );
  expect(res.status).toBe(400);
});

it("requires auth for discard", async () => {
  const res = await app.request("/api/collection/discard", { method: "POST" }, env);
  expect(res.status).toBe(401);
});

it("discards multiple copies at once and credits coins for all of them", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 5).run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: "c1", quantity: 3 }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(15); // 3 x common discard value (5)

  const owned = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  expect(owned?.quantity).toBe(2);
});

it("rejects a bulk discard that would leave 0 copies", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 3).run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: "c1", quantity: 3 }),
    },
    env
  );
  expect(res.status).toBe(409);

  const owned = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  expect(owned?.quantity).toBe(3);
});

it.each([0, -1, 1.5, "3", null])("rejects an invalid quantity (%j)", async (quantity) => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 5).run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/discard",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: "c1", quantity }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("converts a normal card to shiny, consuming a duplicate and coins", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 2).run();
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(200, "1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(50); // 200 - 150 (common conversion cost)

  const normal = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  expect(normal?.quantity).toBe(1);

  const shiny = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1-shiny")
    .first<{ quantity: number }>();
  expect(shiny?.quantity).toBe(1);
});

it("converts a -female card using the -shiny-female id, not -female-shiny", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-female", "Common Card (Hembra)", "common", "/cards/c1-female.png")
    .run();
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny-female", "Common Card Shiny (Hembra)", "common", "/cards/c1-shiny-female.png")
    .run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)")
    .bind("1", "c1-female", 2)
    .run();
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(200, "1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: "c1-female" }),
    },
    env
  );
  expect(res.status).toBe(200);

  const shiny = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1-shiny-female")
    .first<{ quantity: number }>();
  expect(shiny?.quantity).toBe(1);
});

it("adds onto an existing shiny quantity instead of overwriting it", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 2),
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1-shiny", 1),
    env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(200, "1"),
  ]);

  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );

  const shiny = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1-shiny")
    .first<{ quantity: number }>();
  expect(shiny?.quantity).toBe(2);
});

it("rejects converting with only 1 available copy", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 1),
    env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(200, "1"),
  ]);

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(409);
});

it("rejects converting without enough coins", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 2).run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(400);

  const normal = await env.DB.prepare("SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?")
    .bind("1", "c1")
    .first<{ quantity: number }>();
  expect(normal?.quantity).toBe(2); // untouched
});

it("rejects converting a card with no shiny counterpart in the catalog", async () => {
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)").bind("1", "c1", 2).run();
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(9999, "1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1" }) },
    env
  );
  expect(res.status).toBe(404);
});

it("rejects converting a card that is already shiny", async () => {
  await env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)")
    .bind("c1-shiny", "Common Card Shiny", "common", "/cards/c1-shiny.png")
    .run();
  await env.DB.prepare("INSERT INTO user_cards (user_id, card_id, quantity) VALUES (?, ?, ?)")
    .bind("1", "c1-shiny", 2)
    .run();
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(9999, "1").run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    "/api/collection/convert-shiny",
    { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cardId: "c1-shiny" }) },
    env
  );
  expect(res.status).toBe(400);
});

it("requires auth for convert-shiny", async () => {
  const res = await app.request("/api/collection/convert-shiny", { method: "POST" }, env);
  expect(res.status).toBe(401);
});
