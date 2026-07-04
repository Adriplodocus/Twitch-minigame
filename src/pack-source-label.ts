const SOURCE_LABELS: Record<string, string> = {
  reward: "Recompensa",
  admin: "Admin",
  bits: "Bits",
  sub: "Suscripción",
  gift_sub: "Regalo sub",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}
