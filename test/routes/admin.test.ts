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

it("lists all users alphabetically on page 1 with hasMore false when there are 20 or fewer", async () => {
  const cookie = await adminCookie();
  const res = await app.request("/api/admin/users/all", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const json = await res.json<{ users: { username: string }[]; page: number; hasMore: boolean }>();
  expect(json.page).toBe(1);
  expect(json.hasMore).toBe(false);
  expect(json.users.map((u) => u.username)).toEqual(["viewer1", "viewer2"]);
});

it("paginates the full user list with hasMore true when a 21st user exists", async () => {
  const statements = Array.from({ length: 19 }, (_, i) =>
    env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind(`extra-${i}`, `zzz-user-${String(i).padStart(2, "0")}`)
  );
  await env.DB.batch(statements);
  // Now 21 users total: viewer1, viewer2, and 19 "zzz-user-*" (alphabetically last).

  const cookie = await adminCookie();
  const page1 = await app.request("/api/admin/users/all?page=1", { headers: { Cookie: cookie } }, env);
  const page1Json = await page1.json<{ users: { username: string }[]; page: number; hasMore: boolean }>();
  expect(page1Json.page).toBe(1);
  expect(page1Json.users).toHaveLength(20);
  expect(page1Json.hasMore).toBe(true);

  const page2 = await app.request("/api/admin/users/all?page=2", { headers: { Cookie: cookie } }, env);
  const page2Json = await page2.json<{ users: { username: string }[]; page: number; hasMore: boolean }>();
  expect(page2Json.page).toBe(2);
  expect(page2Json.users).toHaveLength(1);
  expect(page2Json.hasMore).toBe(false);
});

it("requires an admin session for the full user list", async () => {
  const res = await app.request("/api/admin/users/all", {}, env);
  expect(res.status).toBe(401);
});
