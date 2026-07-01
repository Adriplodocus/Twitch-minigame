import { it, expect } from "vitest";
import { signSession, verifySession } from "../../worker/lib/jwt";

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
