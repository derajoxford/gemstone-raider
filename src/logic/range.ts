// Range math for PnW declare windows.
// In-range: targetScore in [0.75 * raiderScore, 1.75 * raiderScore].
// Near-range: within +/- nearPct% outside that window.

export type RangeHit =
  | { kind: "in"; deltaPct: number }     // negative if target below raider; positive if above
  | { kind: "near"; side: "below" | "above"; gapPct: number };

export function scoreWindow(raiderScore: number) {
  const min = 0.75 * raiderScore;
  const max = 1.75 * raiderScore;
  return { min, max };
}

export function classifyRange(
  raiderScore: number,
  targetScore: number,
  nearPct: number
): RangeHit | null {
  const { min, max } = scoreWindow(raiderScore);

  if (targetScore >= min && targetScore <= max) {
    const deltaPct = ((targetScore - raiderScore) / raiderScore) * 100;
    return { kind: "in", deltaPct };
  }

  const belowBand = min * (1 - nearPct / 100);
  const aboveBand = max * (1 + nearPct / 100);

  if (targetScore >= belowBand && targetScore < min) {
    const gapPct = ((min - targetScore) / min) * 100;
    return { kind: "near", side: "below", gapPct };
  }

  if (targetScore > max && targetScore <= aboveBand) {
    const gapPct = ((targetScore - max) / max) * 100;
    return { kind: "near", side: "above", gapPct };
  }

  return null;
}
