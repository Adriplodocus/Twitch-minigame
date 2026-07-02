import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { verifySession, verifyAdminSession } from "../lib/jwt";
import type { Env, SessionUser } from "../types";

export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: { user: SessionUser };
}>(async (c, next) => {
  const token = getCookie(c, "session");
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const session = await verifySession(token, c.env.JWT_SECRET);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", session);
  await next();
});

export const requireAdmin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = getCookie(c, "admin_session");
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const valid = await verifyAdminSession(token, c.env.JWT_SECRET);
  if (!valid) return c.json({ error: "Unauthorized" }, 401);
  await next();
});
