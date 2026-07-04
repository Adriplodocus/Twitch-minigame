import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM pack_cards");
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
  ]);
});

it("returns no events and a cursor on the first load (empty since)", async () => {
  const res = await app.request("/api/overlay/events?since=", {}, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ events: unknown[]; cursor: string }>();
  expect(json.events).toEqual([]);
  expect(json.cursor).toBeTruthy();
});

it("does not include packs that were opened but never broadcast", async () => {
  const packResult = await env.DB.prepare(
    "INSERT INTO packs (user_id, opened_at) VALUES (?, CURRENT_TIMESTAMP) RETURNING id"
  )
    .bind("1")
    .first<{ id: number }>();
  await env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packResult!.id, "c1").run();

  const res = await app.request("/api/overlay/events?since=2000-01-01 00:00:00", {}, env);
  const json = await res.json<{ events: unknown[] }>();
  expect(json.events).toEqual([]);
});

it("returns a broadcast pack's cards grouped under one event", async () => {
  const packResult = await env.DB.prepare(
    "INSERT INTO packs (user_id, opened_at, broadcast_at) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id"
  )
    .bind("1")
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packResult!.id, "c1"),
    env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packResult!.id, "c1"),
  ]);

  const res = await app.request("/api/overlay/events?since=2000-01-01 00:00:00", {}, env);
  expect(res.status).toBe(200);
  const json = await res.json<{
    events: { packId: number; username: string; cards: { id: string }[] }[];
    cursor: string;
  }>();
  expect(json.events).toHaveLength(1);
  expect(json.events[0].username).toBe("viewer1");
  expect(json.events[0].cards).toHaveLength(2);
  expect(json.cursor).toBeTruthy();
});

it("only returns events broadcast after the given cursor", async () => {
  const packResult = await env.DB.prepare(
    "INSERT INTO packs (user_id, opened_at, broadcast_at) VALUES (?, CURRENT_TIMESTAMP, '2020-01-01 00:00:00') RETURNING id"
  )
    .bind("1")
    .first<{ id: number }>();
  await env.DB.prepare("INSERT INTO pack_cards (pack_id, card_id) VALUES (?, ?)").bind(packResult!.id, "c1").run();

  const res = await app.request("/api/overlay/events?since=2025-01-01 00:00:00", {}, env);
  const json = await res.json<{ events: unknown[] }>();
  expect(json.events).toEqual([]);
});
