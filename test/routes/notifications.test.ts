import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";
import { notify } from "../../worker/lib/notifications";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM notifications");
  await env.DB.exec("DELETE FROM users");
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();
});

it("reports no unread notifications when there are none", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/notifications/unread", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ unread: false });
});

it("reports unread notifications after one is created", async () => {
  await notify(env, "1", "hello");
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/notifications/unread", { headers: { Cookie: cookie } }, env);
  expect(await res.json()).toEqual({ unread: true });
});

it("lists notifications newest first and includes the link", async () => {
  await notify(env, "1", "first");
  await notify(env, "1", "second", "/somewhere");
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/notifications", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ notifications: { message: string; link: string | null }[] }>();
  expect(json.notifications.map((n) => n.message)).toEqual(["second", "first"]);
  expect(json.notifications[0].link).toBe("/somewhere");
  expect(json.notifications[1].link).toBeNull();
});

it("marks all notifications as read as a side effect of listing them", async () => {
  await notify(env, "1", "hello");
  const cookie = await sessionCookie("1", "viewer1");

  await app.request("/api/notifications", { headers: { Cookie: cookie } }, env);

  const unreadRes = await app.request("/api/notifications/unread", { headers: { Cookie: cookie } }, env);
  expect(await unreadRes.json()).toEqual({ unread: false });
});

it("only returns notifications belonging to the current user", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2").run();
  await notify(env, "2", "not for you");
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/notifications", { headers: { Cookie: cookie } }, env);
  const json = await res.json<{ notifications: unknown[] }>();
  expect(json.notifications).toHaveLength(0);
});

it("rejects unauthenticated requests", async () => {
  const res = await app.request("/api/notifications/unread", {}, env);
  expect(res.status).toBe(401);
});
