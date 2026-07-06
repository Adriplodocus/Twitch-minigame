import { describe, it, expect, vi, afterEach } from "vitest";
import { parseIpnFields, verifyIpn } from "./paypal-ipn";

describe("parseIpnFields", () => {
  it("extracts the core transaction fields", () => {
    const body =
      "txn_id=T1&mc_gross=6.00&mc_currency=EUR&payment_status=Completed&receiver_email=mrklypp%40example.com";
    expect(parseIpnFields(body)).toEqual({
      txnId: "T1",
      amount: 6,
      currency: "EUR",
      paymentStatus: "Completed",
      receiverEmail: "mrklypp@example.com",
      note: null,
    });
  });

  it("picks memo as the note when present", () => {
    const body = "txn_id=T1&mc_gross=2&mc_currency=EUR&payment_status=Completed&receiver_email=a%40b.com&memo=MrKlypp";
    expect(parseIpnFields(body).note).toBe("MrKlypp");
  });

  it("falls back to note field when memo is absent", () => {
    const body = "txn_id=T1&mc_gross=2&mc_currency=EUR&payment_status=Completed&receiver_email=a%40b.com&note=MrKlypp";
    expect(parseIpnFields(body).note).toBe("MrKlypp");
  });

  it("returns null note when neither field is present or both are blank", () => {
    const body = "txn_id=T1&mc_gross=2&mc_currency=EUR&payment_status=Completed&receiver_email=a%40b.com&memo=&note=";
    expect(parseIpnFields(body).note).toBeNull();
  });
});

describe("verifyIpn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns true when PayPal responds VERIFIED", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("VERIFIED")));
    expect(await verifyIpn("txn_id=T1")).toBe(true);
  });

  it("returns false when PayPal responds INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("INVALID")));
    expect(await verifyIpn("txn_id=T1")).toBe(false);
  });
});
