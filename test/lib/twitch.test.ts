import { it, expect, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getTwitchUser,
  createEventSubSubscription,
} from "../../worker/lib/twitch";

it("builds an authorize URL with required params", () => {
  const url = buildAuthorizeUrl({
    clientId: "abc",
    redirectUri: "https://example.com/callback",
    state: "xyz",
    scopes: [],
  });
  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
  expect(parsed.searchParams.get("client_id")).toBe("abc");
  expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
  expect(parsed.searchParams.get("state")).toBe("xyz");
  expect(parsed.searchParams.get("response_type")).toBe("code");
});

it("exchanges an auth code for tokens", async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 14400 }),
      { status: 200 }
    )
  );
  const result = await exchangeCodeForToken(
    { clientId: "abc", clientSecret: "s3cr3t", redirectUri: "https://example.com/callback", code: "code123" },
    fetchImpl as unknown as typeof fetch
  );
  expect(result).toEqual({ accessToken: "at", refreshToken: "rt", expiresIn: 14400 });
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://id.twitch.tv/oauth2/token",
    expect.objectContaining({ method: "POST" })
  );
});

it("fetches the authenticated Twitch user", async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(
      JSON.stringify({ data: [{ id: "42", login: "mrklypp", profile_image_url: "https://img" }] }),
      { status: 200 }
    )
  );
  const user = await getTwitchUser("at", "abc", fetchImpl as unknown as typeof fetch);
  expect(user).toEqual({ id: "42", login: "mrklypp", profileImageUrl: "https://img" });
});

it("creates an EventSub subscription", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 202 }));
  await createEventSubSubscription(
    {
      accessToken: "at",
      clientId: "abc",
      broadcasterId: "99",
      rewardId: "reward-1",
      callbackUrl: "https://example.com/webhook/eventsub",
      secret: "whsecret",
    },
    fetchImpl as unknown as typeof fetch
  );
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://api.twitch.tv/helix/eventsub/subscriptions",
    expect.objectContaining({ method: "POST" })
  );
  const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
  expect(body.type).toBe("channel.channel_points_custom_reward_redemption.add");
  expect(body.condition).toEqual({ broadcaster_user_id: "99", reward_id: "reward-1" });
});
