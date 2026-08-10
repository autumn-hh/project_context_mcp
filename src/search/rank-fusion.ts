/**
 * Rank-based fusion for heterogeneous retrieval channels.
 *
 * Scores from FTS, n-gram coverage, symbol boosts, and vector similarity do
 * not share a reliable numeric scale. RRF combines their ranks instead of
 * comparing those raw scores directly.
 */

export const RRF_K = 60;

export interface RankedList<T> {
  items: T[];
  weight?: number;
}

export interface FusedItem<T> {
  item: T;
  score: number;
}

export function rrfMerge<T>(
  lists: Array<RankedList<T>>,
  getId: (item: T) => string,
  k = RRF_K,
): Array<FusedItem<T>> {
  const merged = new Map<string, FusedItem<T>>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    const seen = new Set<string>();
    for (let index = 0; index < list.items.length; index += 1) {
      const item = list.items[index]!;
      const id = getId(item);
      if (seen.has(id)) continue;
      seen.add(id);
      const contribution = weight / (k + index + 1);
      const existing = merged.get(id);
      if (existing) existing.score += contribution;
      else merged.set(id, { item, score: contribution });
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score);
}
