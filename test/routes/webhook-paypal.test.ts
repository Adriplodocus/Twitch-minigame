import { env } from "cloudflare:test";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import app from "../../worker";
import * as paypalIpn from "../../worker/lib/paypal-ipn";

const RECEIVER = "mrklypp@example.com";

function ipnBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM packs");
  await env.DB.exec("DELETE FROM users");
  await env.DB.exec("DELETE FROM paypal_donations");
  await env.DB.exec("UPDATE pack_grant_config SET paypal_threshold = 2, paypal_quantity = 1 WHERE id = 1");
  await env.DB.prepare("INSERT INTO users (twitch_id, username) VALUES (?, ?)").bind("42", "mrklypp").run();
  env.PAYPAL_RECEIVER_EMAIL = RECEIVER;
  vi.spyOn(paypalIpn, "verifyIpn").mockResolvedValue(true);
});

afterEach(() => vi.restoreAllMocks());

it("grants a pack when a valid EUR donation matches a username in the note", async () => {
  const body = ipnBody({
    txn_id: "T1",
    mc_gross: "2.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  const res = await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  expect(res.status).toBe(200);
  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?").bind("42").all();
  expect(packs.results).toEqual([{ source: "paypal", tier: "apoyo" }]);
  const donation = await env.DB.prepare("SELECT status, packs_granted FROM paypal_donations WHERE txn_id = ?")
    .bind("T1")
    .first();
  expect(donation).toEqual({ status: "granted", packs_granted: 1 });
});

it("scales packs granted with the donation amount", async () => {
  const body = ipnBody({
    txn_id: "T2",
    mc_gross: "6.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const packs = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("42").all();
  expect(packs.results).toHaveLength(3);
});

it("does not grant when IPN verification fails", async () => {
  vi.spyOn(paypalIpn, "verifyIpn").mockResolvedValue(false);
  const body = ipnBody({
    txn_id: "T3",
    mc_gross: "2.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  const res = await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  expect(res.status).toBe(200);
  const packs = await env.DB.prepare("SELECT * FROM packs").all();
  expect(packs.results).toHaveLength(0);
  const donation = await env.DB.prepare("SELECT * FROM paypal_donations WHERE txn_id = ?").bind("T3").first();
  expect(donation).toBeNull();
});

it("does not grant when receiver_email does not match", async () => {
  const body = ipnBody({
    txn_id: "T4",
    mc_gross: "2.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: "someone-else@example.com",
    memo: "mrklypp",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const packs = await env.DB.prepare("SELECT * FROM packs").all();
  expect(packs.results).toHaveLength(0);
});

it("ignores a repeated txn_id instead of granting twice", async () => {
  const body = ipnBody({
    txn_id: "T5",
    mc_gross: "2.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);
  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const packs = await env.DB.prepare("SELECT * FROM packs WHERE user_id = ?").bind("42").all();
  expect(packs.results).toHaveLength(1);
});

it("marks the donation unmatched when the note has no matching username", async () => {
  const body = ipnBody({
    txn_id: "T6",
    mc_gross: "2.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "nosuchuser",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const donation = await env.DB.prepare("SELECT status FROM paypal_donations WHERE txn_id = ?")
    .bind("T6")
    .first<{ status: string }>();
  expect(donation?.status).toBe("unmatched");
  const packs = await env.DB.prepare("SELECT * FROM packs").all();
  expect(packs.results).toHaveLength(0);
});

it("marks the donation unmatched when the currency is not EUR", async () => {
  const body = ipnBody({
    txn_id: "T7",
    mc_gross: "10.00",
    mc_currency: "USD",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const donation = await env.DB.prepare("SELECT status FROM paypal_donations WHERE txn_id = ?")
    .bind("T7")
    .first<{ status: string }>();
  expect(donation?.status).toBe("unmatched");
});

it("marks the donation ignored when the amount is below threshold", async () => {
  const body = ipnBody({
    txn_id: "T8",
    mc_gross: "1.00",
    mc_currency: "EUR",
    payment_status: "Completed",
    receiver_email: RECEIVER,
    memo: "mrklypp",
  });

  await app.request("/webhook/paypal-ipn", { method: "POST", body }, env);

  const donation = await env.DB.prepare("SELECT status FROM paypal_donations WHERE txn_id = ?")
    .bind("T8")
    .first<{ status: string }>();
  expect(donation?.status).toBe("ignored");
});
