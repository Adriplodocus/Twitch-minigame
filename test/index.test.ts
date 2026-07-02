import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import app from "../worker";

it("responds to health check", async () => {
  const res = await app.request("/api/health", {}, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
