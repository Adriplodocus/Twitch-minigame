import { Hono } from "hono";
import type { Env } from "./types";
import auth from "./routes/auth";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", auth);

export default app;
