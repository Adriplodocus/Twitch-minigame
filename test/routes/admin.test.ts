import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signAdminSession, signSession } from "../../worker/lib/jwt";

async function adminCookie(): Promise<string> {
  const token = await signAdminSession(env.JWT_SECRET);
  return `admin_session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM packs");
  await env.DB.exec("DELETE FROM users");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1"),
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("2", "viewer2"),
  ]);
});

it("rejects login with the wrong password", async () => {
  const res = await app.request(
    "/api/admin/login",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }) },
    env
  );
  expect(res.status).toBe(401);
});

it("accepts login with the correct password and sets a cookie", async () => {
  const res = await app.request(
    "/api/admin/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    },
    env
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("admin_session=");
});

it("requires an admin session for protected routes", async () => {
  const res = await app.request("/api/admin/users?q=viewer", {}, env);
  expect(res.status).toBe(401);
});

it("rejects a player session cookie on admin routes", async () => {
  const token = await signSession({ twitchId: "1", username: "viewer1" }, env.JWT_SECRET);
  const res = await app.request("/api/admin/users?q=viewer", { headers: { Cookie: `session=${token}` } }, env);
  expect(res.status).toBe(401);
});

it("searches users by username", async () => {
  const cookie = await adminCookie();
  const res = await app.request("/api/admin/users?q=viewer1", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ users: { twitchId: string; username: string }[] }>();
  expect(json.users).toHaveLength(1);
  expect(json.users[0].username).toBe("viewer1");
});

it("rejects grant-packs with an out-of-range quantity", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 0 }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects grant-packs for a nonexistent user", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "does-not-exist", quantity: 1 }),
    },
    env
  );
  expect(res.status).toBe(404);
});

it("grants packs with source 'admin' and lists them in history", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 3 }),
    },
    env
  );
  expect(res.status).toBe(200);

  const packs = await env.DB.prepare("SELECT source FROM packs WHERE user_id = ?").bind("1").all<{ source: string }>();
  expect(packs.results).toHaveLength(3);
  expect(packs.results.every((p) => p.source === "admin")).toBe(true);

  const historyRes = await app.request("/api/admin/history", { headers: { Cookie: cookie } }, env);
  const historyJson = await historyRes.json<{ history: { username: string }[] }>();
  expect(historyJson.history).toHaveLength(3);
  expect(historyJson.history[0].username).toBe("viewer1");
});

it("logs out by clearing the admin session cookie", async () => {
  const res = await app.request("/api/admin/logout", { method: "POST" }, env);
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("admin_session=");
});
