/**
 * Shared portion-multiplier vocabulary. Before this existed, TodayList rendered
 * 0.5 -> "½×" while Again rendered the same array as the raw "0.5×" - the same concept,
 * two different readings depending which screen you happened to be on.
 */

export const MULTIPLIERS = [0.5, 1, 1.5, 2] as const;

const LABELS: Record<number, string> = {
  0.5: "½×",
  1.5: "1½×",
};

export function formatMultiplier(m: number): string {
  return LABELS[m] ?? `${m}×`;
}
