export interface PhoneFocusCandidate {
  key: string;
  top: number;
  bottom: number;
  expanded: boolean;
}

/** Compare visible height, not total node height: long off-screen nodes do not win. */
export function choosePhoneFocus(
  candidates: PhoneFocusCandidate[],
  height: number,
  previous: string | null,
): string | null {
  if (height < 100) return null;
  const bandTop = height * 0.22;
  const bandBottom = height * 0.76;
  const scored = candidates
    .filter(
      (node) => node.expanded && node.bottom > bandTop && node.top < bandBottom,
    )
    .map((node) => ({
      key: node.key,
      score: Math.max(0, Math.min(height, node.bottom) - Math.max(0, node.top)),
    }))
    .filter((node) => node.score >= 64)
    .sort((a, b) => b.score - a.score);
  const winner = scored[0];
  if (!winner) return null;
  const current = scored.find((node) => node.key === previous);
  if (current && winner.score < current.score * 1.18 + 12) return current.key;
  return winner.key;
}
