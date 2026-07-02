import { it, expect } from "vitest";
import { signSession, verifySession, signAdminSession, verifyAdminSession } from "../../worker/lib/jwt";

const SECRET = "test-secret-value-with-enough-length";

it("round-trips a signed session", async () => {
  const token = await signSession({ twitchId: "123", username: "mrklypp" }, SECRET);
  const session = await verifySession(token, SECRET);
  expect(session).toEqual({ twitchId: "123", username: "mrklypp" });
});

it("rejects a token signed with a different secret", async () => {
  const token = await signSession({ twitchId: "123", username: "mrklypp" }, SECRET);
  const session = await verifySession(token, "a-completely-different-secret");
  expect(session).toBeNull();
});

it("rejects a malformed token", async () => {
  const session = await verifySession("not-a-jwt", SECRET);
  expect(session).toBeNull();
});

it("round-trips a signed admin session", async () => {
  const token = await signAdminSession(SECRET);
  const valid = await verifyAdminSession(token, SECRET);
  expect(valid).toBe(true);
});

it("rejects an admin session signed with a different secret", async () => {
  const token = await signAdminSession(SECRET);
  const valid = await verifyAdminSession(token, "a-completely-different-secret");
  expect(valid).toBe(false);
});

it("rejects a malformed admin session token", async () => {
  const valid = await verifyAdminSession("not-a-jwt", SECRET);
  expect(valid).toBe(false);
});

it("does not accept a player session token as an admin session", async () => {
  const playerToken = await signSession({ twitchId: "123", username: "mrklypp" }, SECRET);
  const valid = await verifyAdminSession(playerToken, SECRET);
  expect(valid).toBe(false);
});
