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
  expect(await res.json()).toEqual({ claimed: false });
});

it("claims a daily pack and creates a pending pack", async () => {
  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request("/api/daily-pack/claim", { method: "POST", headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const pack = await env.DB.prepare("SELECT source, tier, opened_at FROM packs WHERE user_id = ?")
    .bind("1")
    .first<{ source: string; tier: string; opened_at: string | null }>();
  expect(pack?.source).toBe("daily");
  expect(pack?.tier).toBe("gratis");
  expect(pack?.opened_at).toBeNull();

  const statusRes = await app.request("/api/daily-pack/status", { headers: { Cookie: cookie } }, env);
  expect(await statusRes.json()).toEqual({ claimed: true });
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
