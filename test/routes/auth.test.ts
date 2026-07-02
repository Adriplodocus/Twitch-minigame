// test/routes/auth.test.ts
import { env } from "cloudflare:test";
import { it, expect, vi, beforeEach } from "vitest";
import app from "../../worker";
import * as twitch from "../../worker/lib/twitch";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM broadcaster_credentials");
  await env.DB.exec("DELETE FROM users");
});

it("redirects to Twitch authorize URL on login", async () => {
  const res = await app.request("/api/auth/login", { redirect: "manual" }, env);
  expect(res.status).toBe(302);
  const location = res.headers.get("Location") ?? "";
  expect(location).toContain("https://id.twitch.tv/oauth2/authorize");
  expect(res.headers.get("Set-Cookie")).toContain("oauth_state=");
});

it("rejects callback with mismatched state", async () => {
  const res = await app.request(
    "/api/auth/callback?code=abc&state=wrong",
    { headers: { Cookie: "oauth_state=expected" } },
    env
  );
  expect(res.status).toBe(400);
});

it("creates a user and sets a session cookie on valid callback", async () => {
  vi.spyOn(twitch, "exchangeCodeForToken").mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 14400,
  });
  vi.spyOn(twitch, "getTwitchUser").mockResolvedValue({
    id: "42",
    login: "mrklypp",
    profileImageUrl: "https://img",
  });

  const res = await app.request(
    "/api/auth/callback?code=abc&state=expected",
    { headers: { Cookie: "oauth_state=expected" }, redirect: "manual" },
    env
  );

  expect(res.status).toBe(302);
  expect(res.headers.get("Set-Cookie")).toContain("session=");

  const row = await env.DB.prepare("SELECT twitch_id, username FROM users WHERE twitch_id = ?")
    .bind("42")
    .first<{ twitch_id: string; username: string }>();
  expect(row).toEqual({ twitch_id: "42", username: "mrklypp" });

  vi.restoreAllMocks();
});

it("rejects broadcaster callback when the logged-in Twitch user is not the broadcaster", async () => {
  vi.spyOn(twitch, "exchangeCodeForToken").mockResolvedValue({
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 14400,
  });
  vi.spyOn(twitch, "getTwitchUser").mockResolvedValue({
    id: "not-the-broadcaster",
    login: "someviewer",
    profileImageUrl: "https://img",
  });

  const res = await app.request(
    "/api/auth/broadcaster-callback?code=abc&state=expected",
    { headers: { Cookie: "broadcaster_oauth_state=expected" } },
    env
  );

  expect(res.status).toBe(403);
  vi.restoreAllMocks();
});

it("creates an EventSub subscription with an app access token on a valid broadcaster callback", async () => {
  vi.spyOn(twitch, "exchangeCodeForToken").mockResolvedValue({
    accessToken: "broadcaster-user-token",
    refreshToken: "rt",
    expiresIn: 14400,
  });
  vi.spyOn(twitch, "getTwitchUser").mockResolvedValue({
    id: env.TWITCH_BROADCASTER_ID,
    login: "mrklypp",
    profileImageUrl: "https://img",
  });
  vi.spyOn(twitch, "getAppAccessToken").mockResolvedValue("app-token");
  const createSpy = vi.spyOn(twitch, "createEventSubSubscription").mockResolvedValue(undefined);

  const res = await app.request(
    "/api/auth/broadcaster-callback?code=abc&state=expected",
    { headers: { Cookie: "broadcaster_oauth_state=expected" } },
    env
  );

  expect(res.status).toBe(200);
  expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "app-token" }));

  vi.restoreAllMocks();
});
