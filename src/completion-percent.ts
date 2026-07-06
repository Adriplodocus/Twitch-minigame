export function completionPercent(owned: number, total: number): number {
  if (total === 0 || owned === 0) return 0;
  if (owned === total) return 100;
  return Math.min(99, Math.max(1, Math.round((owned / total) * 100)));
}
