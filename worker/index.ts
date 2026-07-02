import { Hono } from "hono";
import type { Env } from "./types";
import auth from "./routes/auth";
import webhook from "./routes/webhook";
import collection from "./routes/collection";
import trade from "./routes/trade";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", auth);
app.route("/webhook", webhook);
app.route("/api/collection", collection);
app.route("/api/trade", trade);

export default app;
