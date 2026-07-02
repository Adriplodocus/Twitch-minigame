export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TWITCH_REDIRECT_URI: string;
  TWITCH_BROADCASTER_REDIRECT_URI: string;
  TWITCH_EVENTSUB_SECRET: string;
  TWITCH_BROADCASTER_ID: string;
  TWITCH_REWARD_ID: string;
  JWT_SECRET: string;
}

export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface SessionUser {
  twitchId: string;
  username: string;
}
