import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { signSession } from "../lib/jwt";
import * as twitch from "../lib/twitch";
import { requireAuth } from "../middleware/auth";

const auth = new Hono<{ Bindings: Env; Variables: { user: { twitchId: string; username: string } } }>();

auth.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT avatar_url AS avatarUrl, coins FROM users WHERE twitch_id = ?")
    .bind(user.twitchId)
    .first<{ avatarUrl: string | null; coins: number }>();
  return c.json({ ok: true, username: user.username, avatarUrl: row?.avatarUrl ?? null, coins: row?.coins ?? 0 });
});

auth.get("/login", (c) => {
  const state = crypto.randomUUID();
  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const url = twitch.buildAuthorizeUrl({
    clientId: c.env.TWITCH_CLIENT_ID,
    redirectUri: c.env.TWITCH_REDIRECT_URI,
    state,
    scopes: [],
  });
  return c.redirect(url, 302);
});

auth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, "oauth_state");
  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: "Invalid OAuth state" }, 400);
  }

  const token = await twitch.exchangeCodeForToken({
    clientId: c.env.TWITCH_CLIENT_ID,
    clientSecret: c.env.TWITCH_CLIENT_SECRET,
    redirectUri: c.env.TWITCH_REDIRECT_URI,
    code,
  });
  const twitchUser = await twitch.getTwitchUser(token.accessToken, c.env.TWITCH_CLIENT_ID);

  await c.env.DB.prepare(
    `INSERT INTO users (twitch_id, username, avatar_url) VALUES (?, ?, ?)
     ON CONFLICT(twitch_id) DO UPDATE SET username = excluded.username, avatar_url = excluded.avatar_url`
  )
    .bind(twitchUser.id, twitchUser.login, twitchUser.profileImageUrl)
    .run();

  const sessionToken = await signSession(
    { twitchId: twitchUser.id, username: twitchUser.login },
    c.env.JWT_SECRET
  );
  deleteCookie(c, "oauth_state", { path: "/" });
  setCookie(c, "session", sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.redirect("/collection.html", 302);
});

auth.post("/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

auth.get("/broadcaster-login", (c) => {
  const state = crypto.randomUUID();
  setCookie(c, "broadcaster_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const url = twitch.buildAuthorizeUrl({
    clientId: c.env.TWITCH_CLIENT_ID,
    redirectUri: c.env.TWITCH_BROADCASTER_REDIRECT_URI,
    state,
    scopes: ["channel:read:redemptions", "bits:read", "channel:read:subscriptions"],
  });
  return c.redirect(url, 302);
});

auth.get("/broadcaster-callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, "broadcaster_oauth_state");
  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: "Invalid OAuth state" }, 400);
  }

  const token = await twitch.exchangeCodeForToken({
    clientId: c.env.TWITCH_CLIENT_ID,
    clientSecret: c.env.TWITCH_CLIENT_SECRET,
    redirectUri: c.env.TWITCH_BROADCASTER_REDIRECT_URI,
    code,
  });
  const twitchUser = await twitch.getTwitchUser(token.accessToken, c.env.TWITCH_CLIENT_ID);

  if (twitchUser.id !== c.env.TWITCH_BROADCASTER_ID) {
    return c.json({ error: "Only the broadcaster account can complete this step" }, 403);
  }

  const expiresAt = new Date(Date.now() + token.expiresIn * 1000).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO broadcaster_credentials (twitch_id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(twitch_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`
  )
    .bind(twitchUser.id, token.accessToken, token.refreshToken, expiresAt)
    .run();

  const appAccessToken = await twitch.getAppAccessToken({
    clientId: c.env.TWITCH_CLIENT_ID,
    clientSecret: c.env.TWITCH_CLIENT_SECRET,
  });
  const callbackUrl = new URL("/webhook/eventsub", c.req.url).toString();
  const broadcasterId = c.env.TWITCH_BROADCASTER_ID;
  const subscriptions: { type: string; version: string; condition: Record<string, string> }[] = [
    {
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: broadcasterId, reward_id: c.env.TWITCH_REWARD_ID },
    },
    { type: "channel.cheer", version: "1", condition: { broadcaster_user_id: broadcasterId } },
    { type: "channel.subscribe", version: "1", condition: { broadcaster_user_id: broadcasterId } },
    { type: "channel.subscription.message", version: "1", condition: { broadcaster_user_id: broadcasterId } },
    { type: "channel.subscription.gift", version: "1", condition: { broadcaster_user_id: broadcasterId } },
  ];
  for (const subscription of subscriptions) {
    await twitch.createEventSubSubscription({
      accessToken: appAccessToken,
      clientId: c.env.TWITCH_CLIENT_ID,
      callbackUrl,
      secret: c.env.TWITCH_EVENTSUB_SECRET,
      ...subscription,
    });
  }

  deleteCookie(c, "broadcaster_oauth_state", { path: "/" });
  return c.json({ ok: true, message: "EventSub subscription created" });
});

export default auth;
