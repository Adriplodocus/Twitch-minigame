import { it, expect } from "vitest";
import { verifyEventSubSignature } from "../../worker/lib/eventsub";

async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

it("accepts a correctly signed payload", async () => {
  const secret = "whsecret";
  const messageId = "msg-1";
  const timestamp = "2026-01-01T00:00:00Z";
  const body = JSON.stringify({ hello: "world" });
  const signatureHeader = await sign(secret, messageId + timestamp + body);

  const valid = await verifyEventSubSignature({ secret, messageId, timestamp, body, signatureHeader });
  expect(valid).toBe(true);
});

it("rejects a tampered payload", async () => {
  const secret = "whsecret";
  const messageId = "msg-1";
  const timestamp = "2026-01-01T00:00:00Z";
  const body = JSON.stringify({ hello: "world" });
  const signatureHeader = await sign(secret, messageId + timestamp + body);

  const valid = await verifyEventSubSignature({
    secret,
    messageId,
    timestamp,
    body: JSON.stringify({ hello: "tampered" }),
    signatureHeader,
  });
  expect(valid).toBe(false);
});

it("rejects a signature made with the wrong secret", async () => {
  const messageId = "msg-1";
  const timestamp = "2026-01-01T00:00:00Z";
  const body = JSON.stringify({ hello: "world" });
  const signatureHeader = await sign("wrong-secret", messageId + timestamp + body);

  const valid = await verifyEventSubSignature({ secret: "whsecret", messageId, timestamp, body, signatureHeader });
  expect(valid).toBe(false);
});
