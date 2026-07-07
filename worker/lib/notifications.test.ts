import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import { notify } from "./notifications";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM notifications");
  await env.DB.exec("DELETE FROM users");
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();
});

it("inserts a notification for a user", async () => {
  await notify(env, "1", "hello");
  const row = await env.DB.prepare("SELECT message, link, read FROM notifications WHERE user_id = ?")
    .bind("1")
    .first<{ message: string; link: string | null; read: number }>();
  expect(row).toEqual({ message: "hello", link: null, read: 0 });
});

it("stores an optional link", async () => {
  await notify(env, "1", "hello", "/somewhere");
  const row = await env.DB.prepare("SELECT link FROM notifications WHERE user_id = ?")
    .bind("1")
    .first<{ link: string }>();
  expect(row?.link).toBe("/somewhere");
});

it("keeps only the 20 most recent notifications per user, deleting the oldest on overflow", async () => {
  for (let i = 0; i < 25; i++) {
    await notify(env, "1", `message ${i}`);
  }
  const rows = await env.DB.prepare("SELECT message FROM notifications WHERE user_id = ? ORDER BY id ASC")
    .bind("1")
    .all<{ message: string }>();
  expect(rows.results).toHaveLength(20);
  expect(rows.results[0].message).toBe("message 5");
  expect(rows.results[19].message).toBe("message 24");
});

it("does not delete other users' notifications when purging overflow", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2").run();
  await notify(env, "2", "keep me");
  for (let i = 0; i < 25; i++) {
    await notify(env, "1", `message ${i}`);
  }
  const row = await env.DB.prepare("SELECT message FROM notifications WHERE user_id = ?")
    .bind("2")
    .first<{ message: string }>();
  expect(row?.message).toBe("keep me");
});
