import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import { handleScheduled } from "./scheduled";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM notifications");
  await env.DB.exec("DELETE FROM daily_pack_claims");
  await env.DB.exec("DELETE FROM daily_streaks");
  await env.DB.exec("DELETE FROM users");
});

it("notifies every registered user when the daily pack becomes available", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2").run();

  await handleScheduled({ cron: "0 0 * * *" } as ScheduledController, env);

  const rows = await env.DB.prepare("SELECT user_id, message FROM notifications ORDER BY user_id").all<{
    user_id: string;
    message: string;
  }>();
  expect(rows.results).toEqual([
    { user_id: "1", message: "¡Sobre diario disponible! Canjéalo para mantener tu racha." },
    { user_id: "2", message: "¡Sobre diario disponible! Canjéalo para mantener tu racha." },
  ]);
});

it("warns users with an active streak who haven't claimed today", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();
  await env.DB.prepare(
    "INSERT INTO daily_streaks (user_id, current_streak, last_claim_date) VALUES (?, ?, date('now', '-1 day'))"
  )
    .bind("1", 3)
    .run();

  await handleScheduled({ cron: "0 21 * * *" } as ScheduledController, env);

  const rows = await env.DB.prepare("SELECT message FROM notifications WHERE user_id = ?").bind("1").all<{
    message: string;
  }>();
  expect(rows.results).toEqual([{ message: "Estás a punto de perder tu racha. Canjea el sobre diario para mantenerla." }]);
});

it("does not warn a user who already claimed today", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();
  await env.DB.prepare(
    "INSERT INTO daily_streaks (user_id, current_streak, last_claim_date) VALUES (?, ?, date('now'))"
  )
    .bind("1", 3)
    .run();
  await env.DB.prepare("INSERT INTO daily_pack_claims (user_id, claim_date) VALUES (?, date('now'))").bind("1").run();

  await handleScheduled({ cron: "0 21 * * *" } as ScheduledController, env);

  const rows = await env.DB.prepare("SELECT id FROM notifications WHERE user_id = ?").bind("1").all();
  expect(rows.results).toHaveLength(0);
});

it("does not warn a user with no active streak", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();
  await env.DB.prepare(
    "INSERT INTO daily_streaks (user_id, current_streak, last_claim_date) VALUES (?, ?, date('now', '-5 day'))"
  )
    .bind("1", 0)
    .run();

  await handleScheduled({ cron: "0 21 * * *" } as ScheduledController, env);

  const rows = await env.DB.prepare("SELECT id FROM notifications WHERE user_id = ?").bind("1").all();
  expect(rows.results).toHaveLength(0);
});

it("does nothing for an unrecognized cron", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();

  await handleScheduled({ cron: "0 12 * * *" } as ScheduledController, env);

  const rows = await env.DB.prepare("SELECT id FROM notifications").all();
  expect(rows.results).toHaveLength(0);
});
