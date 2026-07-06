import { Hono } from "hono";
import type { Env } from "../types";
import * as paypalIpn from "../lib/paypal-ipn";
import { grantPacks } from "../lib/grants";

const webhookPaypal = new Hono<{ Bindings: Env }>();

interface PaypalConfig {
  paypal_threshold: number;
  paypal_quantity: number;
}

async function getPaypalConfig(db: D1Database): Promise<PaypalConfig> {
  const row = await db
    .prepare("SELECT paypal_threshold, paypal_quantity FROM pack_grant_config WHERE id = 1")
    .first<PaypalConfig>();
  return row!;
}

async function recordDonation(
  db: D1Database,
  txnId: string,
  amount: number,
  currency: string,
  note: string | null,
  status: "granted" | "unmatched" | "ignored",
  matchedUsername: string | null,
  matchedUserId: string | null,
  packsGranted: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO paypal_donations
        (txn_id, amount, currency, note_raw, matched_username, matched_user_id, status, packs_granted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(txnId, amount, currency, note, matchedUsername, matchedUserId, status, packsGranted)
    .run();
}

webhookPaypal.post("/paypal-ipn", async (c) => {
  const rawBody = await c.req.text();

  const verified = await paypalIpn.verifyIpn(rawBody);
  if (!verified) return c.json({ ok: true }, 200);

  const fields = paypalIpn.parseIpnFields(rawBody);
  if (fields.receiverEmail !== c.env.PAYPAL_RECEIVER_EMAIL) return c.json({ ok: true }, 200);
  if (fields.paymentStatus !== "Completed") return c.json({ ok: true }, 200);
  if (!fields.txnId) return c.json({ ok: true }, 200);

  const existing = await c.env.DB.prepare("SELECT txn_id FROM paypal_donations WHERE txn_id = ?")
    .bind(fields.txnId)
    .first();
  if (existing) return c.json({ ok: true }, 200);

  const config = await getPaypalConfig(c.env.DB);

  if (fields.currency !== "EUR") {
    await recordDonation(
      c.env.DB,
      fields.txnId,
      fields.amount,
      fields.currency,
      fields.note,
      "unmatched",
      null,
      null,
      0
    );
    return c.json({ ok: true }, 200);
  }
  if (fields.amount < config.paypal_threshold) {
    await recordDonation(
      c.env.DB,
      fields.txnId,
      fields.amount,
      fields.currency,
      fields.note,
      "ignored",
      null,
      null,
      0
    );
    return c.json({ ok: true }, 200);
  }

  const user = fields.note
    ? await c.env.DB.prepare("SELECT twitch_id, username FROM users WHERE LOWER(username) = LOWER(?)")
        .bind(fields.note)
        .first<{ twitch_id: string; username: string }>()
    : null;

  if (!user) {
    await recordDonation(
      c.env.DB,
      fields.txnId,
      fields.amount,
      fields.currency,
      fields.note,
      "unmatched",
      fields.note,
      null,
      0
    );
    return c.json({ ok: true }, 200);
  }

  const packs = Math.floor(fields.amount / config.paypal_threshold) * config.paypal_quantity;
  await grantPacks(c.env.DB, user.twitch_id, packs, "paypal", "apoyo");
  await recordDonation(
    c.env.DB,
    fields.txnId,
    fields.amount,
    fields.currency,
    fields.note,
    "granted",
    user.username,
    user.twitch_id,
    packs
  );

  return c.json({ ok: true }, 200);
});

export default webhookPaypal;
