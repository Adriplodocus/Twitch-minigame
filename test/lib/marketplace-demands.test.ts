import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import { closeDemand } from "../../worker/lib/marketplace-demands";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM trade_offers");
  await env.DB.exec("DELETE FROM marketplace_offers");
  await env.DB.exec("DELETE FROM cards");
  await env.DB.exec("DELETE FROM users");

  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1"),
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2"),
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("3", "viewer3"),
    env.DB.prepare("INSERT INTO cards (id, name, rarity, image_path) VALUES (?, ?, ?, ?)").bind(
      "p1",
      "Pikachu",
      "common",
      "/cards/p1.png"
    ),
  ]);
});

it("deletes the demand row", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1') RETURNING id"
  ).first<{ id: number }>();

  await closeDemand(env, demandId);

  const row = await env.DB.prepare("SELECT id FROM marketplace_offers WHERE id = ?").bind(demandId).first();
  expect(row).toBeNull();
});

it("declines every pending trade offer linked to the demand", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1') RETURNING id"
  ).first<{ id: number }>();
  const { id: offerB } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('2', '1', ?) RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();
  const { id: offerC } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('3', '1', ?) RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();

  await closeDemand(env, demandId);

  const rows = await env.DB.prepare("SELECT id, status FROM trade_offers WHERE id IN (?, ?)")
    .bind(offerB, offerC)
    .all<{ id: number; status: string }>();
  expect(rows.results).toEqual(
    expect.arrayContaining([
      { id: offerB, status: "declined" },
      { id: offerC, status: "declined" },
    ])
  );
});

it("excludes exceptOfferId from being declined", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1') RETURNING id"
  ).first<{ id: number }>();
  const { id: acceptedOffer } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id, status) VALUES ('2', '1', ?, 'accepted') RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();
  const { id: otherOffer } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('3', '1', ?) RETURNING id"
  )
    .bind(demandId)
    .first<{ id: number }>();

  await closeDemand(env, demandId, acceptedOffer);

  const accepted = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(acceptedOffer)
    .first<{ status: string }>();
  expect(accepted?.status).toBe("accepted"); // untouched

  const other = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(otherOffer)
    .first<{ status: string }>();
  expect(other?.status).toBe("declined");
});

it("does not touch trade offers linked to a different demand", async () => {
  const { id: demandA } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1') RETURNING id"
  ).first<{ id: number }>();
  const { id: demandB } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('2', 'p1') RETURNING id"
  ).first<{ id: number }>();
  const { id: offerOnB } = await env.DB.prepare(
    "INSERT INTO trade_offers (from_user, to_user, marketplace_demand_id) VALUES ('3', '2', ?) RETURNING id"
  )
    .bind(demandB)
    .first<{ id: number }>();

  await closeDemand(env, demandA);

  const row = await env.DB.prepare("SELECT status FROM trade_offers WHERE id = ?")
    .bind(offerOnB)
    .first<{ status: string }>();
  expect(row?.status).toBe("pending");
});

it("is a no-op when called twice on the same already-gone demand", async () => {
  const { id: demandId } = await env.DB.prepare(
    "INSERT INTO marketplace_offers (creator_id, demand_card_id) VALUES ('1', 'p1') RETURNING id"
  ).first<{ id: number }>();

  await closeDemand(env, demandId);
  await expect(closeDemand(env, demandId)).resolves.toBeUndefined();
});
