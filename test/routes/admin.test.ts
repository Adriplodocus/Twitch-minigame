import { env } from "cloudflare:test";
import { it, expect, vi, beforeEach } from "vitest";
import app from "../../worker";
import { signAdminSession, signSession } from "../../worker/lib/jwt";
import * as twitch from "../../worker/lib/twitch";

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

it("rejects lookup-user requests without an admin session", async () => {
  const res = await app.request(
    "/api/admin/lookup-user",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "x" }) },
    env
  );
  expect(res.status).toBe(401);
});

it("rejects lookup-user with a missing username", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/lookup-user",
    { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({}) },
    env
  );
  expect(res.status).toBe(400);
});

it("returns an existing local user without calling Twitch", async () => {
  const getAppAccessTokenSpy = vi.spyOn(twitch, "getAppAccessToken");
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/lookup-user",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ username: "viewer1" }),
    },
    env
  );
  expect(res.status).toBe(200);
  const { user } = await res.json<{ user: { twitchId: string; username: string } }>();
  expect(user).toEqual({ twitchId: "1", username: "viewer1", avatarUrl: null });
  expect(getAppAccessTokenSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it("creates a user from Twitch when there is no local match", async () => {
  vi.spyOn(twitch, "getAppAccessToken").mockResolvedValue("app-token");
  vi.spyOn(twitch, "getUserByLogin").mockResolvedValue({
    id: "999",
    login: "brandnew",
    profileImageUrl: "https://img",
  });

  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/lookup-user",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ username: "brandnew" }),
    },
    env
  );
  expect(res.status).toBe(200);
  const { user } = await res.json<{ user: { twitchId: string; username: string; avatarUrl: string } }>();
  expect(user).toEqual({ twitchId: "999", username: "brandnew", avatarUrl: "https://img" });

  const row = await env.DB.prepare("SELECT twitch_id, username, avatar_url FROM users WHERE twitch_id = ?")
    .bind("999")
    .first();
  expect(row).toEqual({ twitch_id: "999", username: "brandnew", avatar_url: "https://img" });

  vi.restoreAllMocks();
});

it("returns 404 when Twitch has no user with that login", async () => {
  vi.spyOn(twitch, "getAppAccessToken").mockResolvedValue("app-token");
  vi.spyOn(twitch, "getUserByLogin").mockResolvedValue(null);

  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/lookup-user",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ username: "doesnotexist" }),
    },
    env
  );
  expect(res.status).toBe(404);

  vi.restoreAllMocks();
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
      paypalThreshold: number;
      paypalQuantity: number;
    };
  }>();
  expect(config).toEqual({
    rewardQuantity: 1,
    bitsThreshold: 200,
    bitsQuantity: 1,
    subQuantity: 1,
    giftSubMultiplier: 1,
    paypalThreshold: 2,
    paypalQuantity: 1,
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
        paypalThreshold: 5,
        paypalQuantity: 2,
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
    paypalThreshold: 5,
    paypalQuantity: 2,
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
        paypalThreshold: 2,
        paypalQuantity: 1,
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

it("lists unmatched paypal donations", async () => {
  await env.DB.prepare(
    `INSERT INTO paypal_donations (txn_id, amount, currency, note_raw, status, packs_granted)
     VALUES ('T1', 2, 'EUR', 'typo-user', 'unmatched', 0)`
  ).run();

  const res = await app.request(
    "/api/admin/paypal-donations?status=unmatched",
    { headers: { Cookie: await adminCookie() } },
    env
  );

  expect(res.status).toBe(200);
  const body = await res.json<{ donations: { txnId: string; noteRaw: string }[] }>();
  expect(body.donations).toEqual([expect.objectContaining({ txnId: "T1", noteRaw: "typo-user" })]);
});

it("resolves an unmatched donation by granting packs to the chosen user", async () => {
  await env.DB.prepare(
    `INSERT INTO paypal_donations (txn_id, amount, currency, note_raw, status, packs_granted)
     VALUES ('T2', 2, 'EUR', 'typo-user', 'unmatched', 0)`
  ).run();

  const res = await app.request(
    "/api/admin/paypal-donations/T2/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await adminCookie() },
      body: JSON.stringify({ twitchId: "1", quantity: 1 }),
    },
    env
  );

  expect(res.status).toBe(200);
  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?").bind("1").all();
  expect(packs.results).toEqual([{ source: "paypal_manual", tier: "apoyo" }]);
  const donation = await env.DB.prepare("SELECT status, matched_user_id FROM paypal_donations WHERE txn_id = ?")
    .bind("T2")
    .first();
  expect(donation).toEqual({ status: "granted", matched_user_id: "1" });
});

it("rejects resolving a donation that was already granted", async () => {
  await env.DB.prepare(
    `INSERT INTO paypal_donations (txn_id, amount, currency, status, packs_granted)
     VALUES ('T3', 2, 'EUR', 'granted', 1)`
  ).run();

  const res = await app.request(
    "/api/admin/paypal-donations/T3/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await adminCookie() },
      body: JSON.stringify({ twitchId: "1", quantity: 1 }),
    },
    env
  );

  expect(res.status).toBe(409);
});

it("opens a test pack, leaving it opened but not broadcast", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES ('__test__', 'Prueba')").run();
  await env.DB.prepare(
    "INSERT INTO cards (id, name, rarity, image_path, generation) VALUES (?, ?, ?, ?, ?)"
  )
    .bind("c1", "Common Card", "common", "/cards/c1.png", 1)
    .run();

  const res = await app.request(
    "/api/admin/test-pack",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await adminCookie() },
      body: JSON.stringify({ generation: 1, tier: "gratis" }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ packId: number; cards: { id: string }[] }>();
  expect(json.cards).toHaveLength(10);

  const pack = await env.DB.prepare("SELECT opened_at, broadcast_at, is_test FROM packs WHERE id = ?")
    .bind(json.packId)
    .first<{ opened_at: string | null; broadcast_at: string | null; is_test: number }>();
  expect(pack!.opened_at).not.toBeNull();
  expect(pack!.broadcast_at).toBeNull();
  expect(pack!.is_test).toBe(1);
});

it("broadcasts a test pack that has been opened", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES ('__test__', 'Prueba')").run();
  await env.DB.prepare(
    "INSERT INTO packs (user_id, source, tier, opened_at, is_test) VALUES ('__test__', 'admin', 'gratis', CURRENT_TIMESTAMP, 1)"
  ).run();
  const pack = await env.DB.prepare("SELECT id FROM packs WHERE is_test = 1").first<{ id: number }>();

  const res = await app.request(
    `/api/admin/test-pack/${pack!.id}/broadcast`,
    { method: "POST", headers: { Cookie: await adminCookie() } },
    env
  );
  expect(res.status).toBe(200);

  const updated = await env.DB.prepare("SELECT broadcast_at FROM packs WHERE id = ?")
    .bind(pack!.id)
    .first<{ broadcast_at: string | null }>();
  expect(updated!.broadcast_at).not.toBeNull();
});

it("rejects broadcasting a nonexistent or non-test pack", async () => {
  await env.DB.prepare(
    "INSERT INTO packs (user_id, source, tier, opened_at, is_test) VALUES ('1', 'reward', 'gratis', CURRENT_TIMESTAMP, 0)"
  ).run();
  const realPack = await env.DB.prepare("SELECT id FROM packs WHERE is_test = 0").first<{ id: number }>();

  const res = await app.request(
    `/api/admin/test-pack/${realPack!.id}/broadcast`,
    { method: "POST", headers: { Cookie: await adminCookie() } },
    env
  );
  expect(res.status).toBe(404);
});

it("rejects broadcasting a test pack that has not been opened", async () => {
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES ('__test__', 'Prueba')").run();
  await env.DB.prepare(
    "INSERT INTO packs (user_id, source, tier, is_test) VALUES ('__test__', 'admin', 'gratis', 1)"
  ).run();
  const pack = await env.DB.prepare("SELECT id FROM packs WHERE is_test = 1").first<{ id: number }>();

  const res = await app.request(
    `/api/admin/test-pack/${pack!.id}/broadcast`,
    { method: "POST", headers: { Cookie: await adminCookie() } },
    env
  );
  expect(res.status).toBe(409);
});

