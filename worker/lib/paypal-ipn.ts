export interface ParsedIpn {
  txnId: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  receiverEmail: string;
  note: string | null;
}

const NOTE_FIELDS = ["memo", "note", "item_name"];

export function parseIpnFields(rawBody: string): ParsedIpn {
  const params = new URLSearchParams(rawBody);
  let note: string | null = null;
  for (const field of NOTE_FIELDS) {
    const value = params.get(field);
    if (value && value.trim()) {
      note = value.trim();
      break;
    }
  }
  return {
    txnId: params.get("txn_id") ?? "",
    amount: Number(params.get("mc_gross") ?? "0"),
    currency: params.get("mc_currency") ?? "",
    paymentStatus: params.get("payment_status") ?? "",
    receiverEmail: params.get("receiver_email") ?? "",
    note,
  };
}

export async function verifyIpn(rawBody: string): Promise<boolean> {
  const res = await fetch("https://ipnpb.paypal.com/cgi-bin/webscr", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `cmd=_notify-validate&${rawBody}`,
  });
  const text = await res.text();
  return text === "VERIFIED";
}
