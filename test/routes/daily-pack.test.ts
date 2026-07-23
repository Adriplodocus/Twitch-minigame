// test/routes/daily-pack.test.ts
import { env } from "cloudflare:test";
import { it, expect, beforeEach } from "vitest";
import app from "../../worker";
import { signSession } from "../../worker/lib/jwt";

async function sessionCookie(twitchId: string, username: string): Promise<string> {
  const token = await signSession({ twitchId, username }, env.JWT_SECRET);
  return `session=${token}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM notifications");
  await env.DB.exec("DELETE FROM daily_streaks");
  await env.DB.exec("DELETE FROM daily_pack_claims");
  await env.DB.exec("DELETE FROM pack_cards");
  await env.DB.exec("DELETE FROM user_cards");
  await env.DB.exec("DELETE FROM packs");
  await env.DB.exec("DELETE FROM users");

  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("1", "viewer1").run();
});

it("requires auth", async () => {
  const res = await app.request("/api/daily-pack/status", {}, env);
  expect(res.status).toBe(401);
});

it("reports not claimed before any claim", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/daily-pack/status", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ claimed: false, streak: 0 });
});

it("claims a daily pack and creates a pending pack", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, streak: 1, milestone: false, coinsAwarded: 10, coins: 10 });

  const pack = await env.DB.prepare("SELECT source, tier, opened_at FROM packs WHERE user_id = ?")
    .bind("1")
    .first<{ source: string; tier: string; opened_at: string | null }>();
  expect(pack?.source).toBe("daily");
  expect(pack?.tier).toBe("gratis");
  expect(pack?.opened_at).toBeNull();

  const statusRes = await app.request("/api/daily-pack/status", { headers: { Cookie: cookie } }, env);
  expect(await statusRes.json()).toEqual({ claimed: true, streak: 1 });

  const userRow = await env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?")
    .bind("1")
    .first<{ coins: number }>();
  expect(userRow?.coins).toBe(10);
});

it("increments streak when the previous claim was yesterday", async () => {
  await env.DB.prepare(
    "INSERT INTO daily_streaks (user_id, current_streak, last_claim_date) VALUES (?, ?, date('now', '-1 day'))"
  )
    .bind("1", 3)
    .run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);
  expect(await res.json()).toEqual({ ok: true, streak: 4, milestone: false, coinsAwarded: 40, coins: 40 });
});

it("resets streak to 1 after a gap of more than one day", async () => {
  await env.DB.prepare(
    "INSERT INTO daily_streaks (user_id, current_streak, last_claim_date) VALUES (?, ?, date('now', '-3 day'))"
  )
    .bind("1", 5)
    .run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);
  expect(await res.json()).toEqual({ ok: true, streak: 1, milestone: false, coinsAwarded: 10, coins: 10 });
});

it("grants a bonus apoyo pack when the streak reaches 7", async () => {
  await env.DB.prepare(
    "INSERT INTO daily_streaks (user_id, current_streak, last_claim_date) VALUES (?, ?, date('now', '-1 day'))"
  )
    .bind("1", 6)
    .run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);
  expect(await res.json()).toEqual({ ok: true, streak: 7, milestone: true, coinsAwarded: 90, coins: 90 });

  const bonus = await env.DB.prepare("SELECT tier FROM packs WHERE user_id = ? AND source = 'daily_streak'")
    .bind("1")
    .all();
  expect(bonus.results).toHaveLength(1);
  expect((bonus.results[0] as { tier: string }).tier).toBe("apoyo");

  const allPacks = await env.DB.prepare("SELECT source FROM packs WHERE user_id = ?").bind("1").all();
  expect(allPacks.results).toHaveLength(1);

  const notifications = await env.DB.prepare("SELECT message FROM notifications WHERE user_id = ?").bind("1").all();
  expect(notifications.results).toHaveLength(1);
});

it("does not create a notification when the streak isn't a milestone", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);

  const notifications = await env.DB.prepare("SELECT id FROM notifications WHERE user_id = ?").bind("1").all();
  expect(notifications.results).toHaveLength(0);
});

it("grants a bonus again at the next 7-day milestone", async () => {
  await env.DB.prepare(
    "INSERT INTO daily_streaks (user_id, current_streak, last_claim_date) VALUES (?, ?, date('now', '-1 day'))"
  )
    .bind("1", 13)
    .run();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);
  expect(await res.json()).toEqual({ ok: true, streak: 14, milestone: true, coinsAwarded: 90, coins: 90 });
});

it("rejects a second claim the same day", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);

  const res = await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(409);

  const packs = await env.DB.prepare("SELECT id FROM packs WHERE user_id = ? AND source = 'daily'").bind("1").all();
  expect(packs.results).toHaveLength(1);
});

it("allows only one winner out of concurrent claims", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const [resA, resB] = await Promise.all([
    app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env),
    app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env),
  ]);
  const statuses = [resA.status, resB.status].sort();
  expect(statuses).toEqual([200, 409]);

  const packs = await env.DB.prepare("SELECT id FROM packs WHERE user_id = ? AND source = 'daily'").bind("1").all();
  expect(packs.results).toHaveLength(1);
});
