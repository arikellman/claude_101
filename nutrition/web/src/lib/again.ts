/**
 * Pure logic for the Again screen (plan 4.3): frequency ranking and combo detection.
 * No I/O, no Supabase - unit-testable independent of the UI, same discipline as
 * nutrition.ts.
 */

import type { Entry } from "./types";

export interface ProductLike {
  id: string;
  times_logged: number;
  last_logged_at: string | null;
}

/** Top N products by frequency, most recent first among ties. */
export function rankFrequent<T extends ProductLike>(products: T[], limit = 24): T[] {
  return [...products]
    .sort((a, b) => {
      if (b.times_logged !== a.times_logged) return b.times_logged - a.times_logged;
      return (b.last_logged_at ?? "").localeCompare(a.last_logged_at ?? "");
    })
    .slice(0, limit);
}

/**
 * A candidate combo: a set of products repeatedly logged together in the same sitting.
 */
export interface ComboCandidate {
  productIds: string[];
  occurrences: number;
  /** Most recent time this combo was logged, for tie-breaking display order. */
  lastLoggedAt: string;
}

/** Two entries belong to the same "sitting" if logged within this many minutes. */
const SESSION_GAP_MINUTES = 45;

/** A combo must repeat at least this many times before it's worth a one-tap tile. */
const MIN_OCCURRENCES = 3;

/**
 * Group entries into eating sessions, then find product-id sets that recur across
 * sessions at least MIN_OCCURRENCES times (plan 4.3: "If you log the same 2-4 items
 * together at least three times").
 *
 * Deliberately keyed on `product_id`, not on the entry's free-text name - the same
 * product logged twice with different portions is still the same combo. Entries with
 * no product_id (a one-off food-mode estimate with nothing cached) can't participate:
 * there's nothing stable to match on across sittings.
 *
 * Order-independent: {eggs, toast} and {toast, eggs} are the same combo, so the id set
 * is sorted before being used as a grouping key.
 */
type WithProduct = Entry & { product_id: string };

export function detectCombos(entries: Entry[]): ComboCandidate[] {
  const withProduct = entries
    .filter((e): e is WithProduct => e.product_id !== null)
    .sort((a, b) => a.logged_at.localeCompare(b.logged_at));

  // 1. Cluster into sessions by time proximity.
  const sessions: WithProduct[][] = [];
  let current: WithProduct[] = [];
  let lastTime: number | null = null;

  for (const e of withProduct) {
    const t = new Date(e.logged_at).getTime();
    if (lastTime !== null && t - lastTime > SESSION_GAP_MINUTES * 60_000) {
      if (current.length >= 2) sessions.push(current);
      current = [];
    }
    current.push(e);
    lastTime = t;
  }
  if (current.length >= 2) sessions.push(current);

  // 2. Key each session by its sorted, deduplicated product-id set. A session with a
  //    repeated product (e.g. two eggs logged separately) collapses to one id - the
  //    combo is about WHICH items, not how many rows produced them.
  const byKey = new Map<string, { productIds: string[]; sessions: WithProduct[][] }>();
  for (const session of sessions) {
    const ids = [...new Set(session.map((e) => e.product_id))].sort();
    if (ids.length < 2) continue; // a combo needs at least two distinct items
    const key = ids.join(",");
    const bucket = byKey.get(key) ?? { productIds: ids, sessions: [] };
    bucket.sessions.push(session);
    byKey.set(key, bucket);
  }

  // 3. Keep only combos that recur often enough to be worth a dedicated tile.
  const candidates: ComboCandidate[] = [];
  for (const { productIds, sessions: occ } of byKey.values()) {
    if (occ.length < MIN_OCCURRENCES) continue;
    const lastLoggedAt = occ
      .flatMap((s) => s.map((e) => e.logged_at))
      .sort()
      .at(-1)!;
    candidates.push({ productIds, occurrences: occ.length, lastLoggedAt });
  }

  return candidates.sort((a, b) => b.occurrences - a.occurrences);
}

/** Human label for a combo from its member product names, e.g. "Eggs + Toast + Coffee". */
export function comboLabel(names: string[]): string {
  return names.join(" + ");
}

// ---------------------------------------------------------------------------
// Promoting repeat food/voice dishes into reusable products
//
// Only label, recipe, barcode, and manual entries ever get a `product_id` - a food-mode
// photo or a voice log never does (see api/estimate/route.ts), so no matter how many
// times the same home-cooked dish gets logged that way, it never appears on Again. This
// closes that gap by finding dishes that keep recurring under the same name and turning
// them into a real product, the same as any scanned item.
// ---------------------------------------------------------------------------

/** More than this many repeats and it's clearly a real recurring dish, not a coincidence. */
const PROMOTE_AFTER_OCCURRENCES = 3;

export interface MacroAverage {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
}

export interface FrequentDish {
  /** Display name - the most recent occurrence's casing/wording, not necessarily
   *  identical to earlier ones even though they matched on the normalized key. */
  name: string;
  count: number;
  avg: MacroAverage;
  /** So the caller can backfill product_id onto these once the product exists,
   *  bringing them in line with every other entry that already links to a product. */
  entryIds: string[];
}

/** Trim + lowercase + collapse whitespace, so trivial formatting differences ("Chicken
 *  and rice" vs "chicken and rice ") don't fragment the same dish into separate buckets.
 *  Exported so the caller can match against already-promoted products by the same key. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Food/voice-mode entries with no product_id, grouped by (normalized) name, averaged,
 * and filtered to dishes that have recurred often enough to be worth a permanent tile.
 *
 * Averaging is deliberate, not just convenient: per plan §3.1, consistency matters more
 * than precision, and a mean of several independent estimates of the same real dish is
 * a better number than any single one of them - the random noise in each individual
 * vision estimate partially cancels out.
 */
export function detectFrequentUnlinkedDishes(
  entries: Entry[],
  minOccurrences = PROMOTE_AFTER_OCCURRENCES
): FrequentDish[] {
  const eligible = entries.filter(
    (e) =>
      e.product_id === null &&
      (e.mode === "food" || e.mode === "voice") &&
      (e.status === "estimated" || e.status === "confirmed") &&
      e.calories !== null &&
      e.name !== null &&
      e.name.trim() !== ""
  );

  const byKey = new Map<string, Entry[]>();
  for (const e of eligible) {
    const key = normalizeName(e.name!);
    byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }

  const dishes: FrequentDish[] = [];
  for (const group of byKey.values()) {
    if (group.length <= minOccurrences) continue;

    const sum = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
    for (const e of group) {
      sum.calories += e.calories ?? 0;
      sum.protein_g += e.protein_g ?? 0;
      sum.carbs_g += e.carbs_g ?? 0;
      sum.fat_g += e.fat_g ?? 0;
      sum.fiber_g += e.fiber_g ?? 0;
    }
    const n = group.length;
    const mostRecent = [...group].sort((a, b) => b.logged_at.localeCompare(a.logged_at))[0];

    dishes.push({
      name: mostRecent.name!,
      count: n,
      avg: {
        calories: Math.round(sum.calories / n),
        protein_g: Math.round(sum.protein_g / n),
        carbs_g: Math.round(sum.carbs_g / n),
        fat_g: Math.round(sum.fat_g / n),
        fiber_g: Math.round(sum.fiber_g / n),
      },
      entryIds: group.map((e) => e.id),
    });
  }

  return dishes.sort((a, b) => b.count - a.count);
}
