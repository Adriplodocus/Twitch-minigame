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
