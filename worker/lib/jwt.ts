import { SignJWT, jwtVerify } from "jose";
import type { SessionUser } from "../types";

function getKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(user: SessionUser, secret: string): Promise<string> {
  return new SignJWT({ twitchId: user.twitchId, username: user.username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getKey(secret));
}

export async function verifySession(token: string, secret: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, getKey(secret));
    if (typeof payload.twitchId !== "string" || typeof payload.username !== "string") {
      return null;
    }
    return { twitchId: payload.twitchId, username: payload.username };
  } catch {
    return null;
  }
}

export async function signAdminSession(secret: string): Promise<string> {
  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getKey(secret));
}

export async function verifyAdminSession(token: string, secret: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, getKey(secret));
    return payload.role === "admin";
  } catch {
    return false;
  }
}
