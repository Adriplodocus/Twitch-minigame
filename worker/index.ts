import { Hono } from "hono";
import type { Env } from "./types";
import auth from "./routes/auth";
import webhook from "./routes/webhook";
import webhookPaypal from "./routes/webhook-paypal";
import collection from "./routes/collection";
import trade from "./routes/trade";
import admin from "./routes/admin";
import overlay from "./routes/overlay";
import dailyPack from "./routes/daily-pack";
import notifications from "./routes/notifications";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", auth);
app.route("/webhook", webhook);
app.route("/webhook", webhookPaypal);
app.route("/api/collection", collection);
app.route("/api/trade", trade);
app.route("/api/admin", admin);
app.route("/api/overlay", overlay);
app.route("/api/daily-pack", dailyPack);
app.route("/api/notifications", notifications);

export default app;
