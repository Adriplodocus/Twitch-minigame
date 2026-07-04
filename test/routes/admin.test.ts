import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signAdminSession, signSession } from "../../worker/lib/jwt";

async function adminCookie(adminName = "Test Admin"): Promise<string> {
  const token = await signAdminSession(env.JWT_SECRET, adminName);
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

it("rejects login with a missing name", async () => {
  const res = await app.request(
    "/api/admin/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects login with a blank name", async () => {
  const res = await app.request(
    "/api/admin/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD, name: "   " }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects login with the wrong password", async () => {
  const res = await app.request(
    "/api/admin/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong", name: "Test Admin" }),
    },
    env
  );
  expect(res.status).toBe(401);
});

it("accepts login with the correct password and name, and sets a cookie", async () => {
  const res = await app.request(
    "/api/admin/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD, name: "Test Admin" }),
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
      body: JSON.stringify({ twitchId: "1", quantity: 0, tier: "gratis" }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects grant-packs with a missing or invalid tier", async () => {
  const cookie = await adminCookie();
  const missingTier = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 1 }),
    },
    env
  );
  expect(missingTier.status).toBe(400);

  const invalidTier = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 1, tier: "premium" }),
    },
    env
  );
  expect(invalidTier.status).toBe(400);
});

it("rejects grant-packs for a nonexistent user", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "does-not-exist", quantity: 1, tier: "gratis" }),
    },
    env
  );
  expect(res.status).toBe(404);
});

it("grants packs with the chosen tier, records who granted them, and lists them in history", async () => {
  const cookie = await adminCookie("Grantor Name");
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 3, tier: "apoyo" }),
    },
    env
  );
  expect(res.status).toBe(200);

  const packs = await env.DB.prepare("SELECT source, tier, granted_by AS grantedBy FROM packs WHERE user_id = ?")
    .bind("1")
    .all<{ source: string; tier: string; grantedBy: string | null }>();
  expect(packs.results).toHaveLength(3);
  expect(packs.results.every((p) => p.source === "admin" && p.tier === "apoyo" && p.grantedBy === "Grantor Name")).toBe(
    true
  );

  const historyRes = await app.request("/api/admin/history", { headers: { Cookie: cookie } }, env);
  const { history } = await historyRes.json<{
    history: { username: string; tier: string; source: string; grantedBy: string | null }[];
  }>();
  expect(history).toHaveLength(3);
  expect(history[0].username).toBe("viewer1");
  expect(history[0].tier).toBe("apoyo");
  expect(history[0].source).toBe("admin");
  expect(history[0].grantedBy).toBe("Grantor Name");
});

it("includes non-admin (reward) sourced packs in history with a null grantedBy", async () => {
  await env.DB.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, 'reward', 'gratis')").bind("2").run();
  const cookie = await adminCookie();
  const historyRes = await app.request("/api/admin/history", { headers: { Cookie: cookie } }, env);
  const { history } = await historyRes.json<{
    history: { username: string; source: string; grantedBy: string | null }[];
  }>();
  const rewardRow = history.find((h) => h.username === "viewer2");
  expect(rewardRow).toBeDefined();
  expect(rewardRow!.source).toBe("reward");
  expect(rewardRow!.grantedBy).toBeNull();
});

it("caps history at 25 rows", async () => {
  const statements = Array.from({ length: 30 }, () =>
    env.DB.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, 'reward', 'gratis')").bind("1")
  );
  await env.DB.batch(statements);
  const cookie = await adminCookie();
  const historyRes = await app.request("/api/admin/history", { headers: { Cookie: cookie } }, env);
  const { history } = await historyRes.json<{ history: unknown[] }>();
  expect(history).toHaveLength(25);
});

it("logs out by clearing the admin session cookie", async () => {
  const res = await app.request("/api/admin/logout", { method: "POST" }, env);
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("admin_session=");
});

it("rejects pack-grant-config requests without an admin session", async () => {
  const res = await app.request("/api/admin/pack-grant-config", {}, env);
  expect(res.status).toBe(401);
});

it("returns the default pack-grant-config", async () => {
  const cookie = await adminCookie();
  const res = await app.request("/api/admin/pack-grant-config", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const { config } = await res.json<{
    config: {
      rewardQuantity: number;
      bitsThreshold: number;
      bitsQuantity: number;
      subQuantity: number;
      giftSubMultiplier: number;
    };
  }>();
  expect(config).toEqual({
    rewardQuantity: 1,
    bitsThreshold: 200,
    bitsQuantity: 1,
    subQuantity: 1,
    giftSubMultiplier: 1,
  });
});

it("persists a valid pack-grant-config update", async () => {
  const cookie = await adminCookie();
  const putRes = await app.request(
    "/api/admin/pack-grant-config",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        rewardQuantity: 2,
        bitsThreshold: 300,
        bitsQuantity: 3,
        subQuantity: 4,
        giftSubMultiplier: 5,
      }),
    },
    env
  );
  expect(putRes.status).toBe(200);

  const getRes = await app.request("/api/admin/pack-grant-config", { headers: { Cookie: cookie } }, env);
  const { config } = await getRes.json<{ config: Record<string, number> }>();
  expect(config).toEqual({
    rewardQuantity: 2,
    bitsThreshold: 300,
    bitsQuantity: 3,
    subQuantity: 4,
    giftSubMultiplier: 5,
  });
});

it("rejects a pack-grant-config update with an out-of-range value", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/pack-grant-config",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        rewardQuantity: 1,
        bitsThreshold: 0,
        bitsQuantity: 1,
        subQuantity: 1,
        giftSubMultiplier: 1,
      }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects a pack-grant-config update with a missing field", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/pack-grant-config",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ rewardQuantity: 1, bitsThreshold: 200, bitsQuantity: 1, subQuantity: 1 }),
    },
    env
  );
  expect(res.status).toBe(400);
});

