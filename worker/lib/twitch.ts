export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", opts.state);
  if (opts.scopes.length > 0) url.searchParams.set("scope", opts.scopes.join(" "));
  return url.toString();
}

export async function exchangeCodeForToken(
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
  });
  const res = await fetchImpl("https://id.twitch.tv/oauth2/token", { method: "POST", body });
  if (!res.ok) throw new Error(`Twitch token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in };
}

export async function getTwitchUser(
  accessToken: string,
  clientId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ id: string; login: string; profileImageUrl: string }> {
  const res = await fetchImpl("https://api.twitch.tv/helix/users", {
    headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId },
  });
  if (!res.ok) throw new Error(`Twitch get user failed: ${res.status}`);
  const json = (await res.json()) as {
    data: { id: string; login: string; profile_image_url: string }[];
  };
  const user = json.data[0];
  return { id: user.id, login: user.login, profileImageUrl: user.profile_image_url };
}

export async function createEventSubSubscription(
  opts: {
    accessToken: string;
    clientId: string;
    broadcasterId: string;
    rewardId: string;
    callbackUrl: string;
    secret: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const res = await fetchImpl("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Client-Id": opts.clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: opts.broadcasterId, reward_id: opts.rewardId },
      transport: { method: "webhook", callback: opts.callbackUrl, secret: opts.secret },
    }),
  });
  if (!res.ok) throw new Error(`EventSub subscription creation failed: ${res.status}`);
}
