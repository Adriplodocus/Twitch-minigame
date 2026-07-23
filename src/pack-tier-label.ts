const TIER_LABELS: Record<string, string> = {
  gratis: "Gratis",
  apoyo: "Premium",
};

export function tierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier;
}
