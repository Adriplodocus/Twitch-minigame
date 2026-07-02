import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrationsPath = path.join(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          vars: {
            JWT_SECRET: "test-jwt-secret-key-for-testing-purposes",
            TWITCH_CLIENT_ID: "test-client-id",
            TWITCH_CLIENT_SECRET: "test-client-secret",
            TWITCH_REDIRECT_URI: "http://localhost:8787/api/auth/callback",
            TWITCH_BROADCASTER_REDIRECT_URI: "http://localhost:8787/api/auth/broadcaster-callback",
            TWITCH_EVENTSUB_SECRET: "test-eventsub-secret",
            TWITCH_BROADCASTER_ID: "test-broadcaster-id",
            TWITCH_REWARD_ID: "test-reward-id",
            ADMIN_PASSWORD: "test-admin-password"
          },
        },
      }),
    ],
    test: {
      include: ["worker/**/*.test.ts", "test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
