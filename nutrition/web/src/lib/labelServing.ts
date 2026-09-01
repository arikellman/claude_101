/**
 * Default serving-size suggestion for a scanned nutrition label.
 *
 * A label-mode scan deliberately leaves calories null (api/estimate/route.ts) - it
 * records the product, not a meal. Turning it into a real log means asking how much was
 * eaten, and the label itself usually already says enough to guess well:
 *
 *   - If the package IS one serving (servings_per_package === 1, or the declared
 *     serving is essentially the whole net weight), default to the whole container -
 *     asking "how many containers?" for a single-serve yogurt cup is friction for no
 *     reason.
 *   - If the label states a serving smaller than the package (a 500 g bag with a
 *     declared 100 g serving), default to one serving of that size and let the user
 *     say how many, rather than defaulting to "the whole bag."
 *   - If nothing about package size is stated at all, fall back to the label's own
 *     per-100g basis as the unit, since that's the only amount actually printed.
 *
 * Pure function, no I/O - the caller reads these three fields out of the entry's
 * retained `ai_raw` (the full LabelResult from the scan), no extra query needed.
 */

export interface LabelSizeFields {
  serving_grams: number;
  servings_per_package: number;
  net_weight_grams: number;
}

export interface LabelServingSuggestion {
  /** True when the sensible default is "the whole thing" - a single-serve container. */
  isWholeContainer: boolean;
  /** What the quantity input should start at. */
  defaultGrams: number;
  /** Step size when asking "how many servings of this size" in the multi-serving case. */
  unitGrams: number;
  /** Whole-container weight, if it can be determined - always offered as an option
   *  even in the multi-serving case, for whenever the whole thing WAS eaten. */
  containerGrams: number | null;
}

/** Treat a declared serving within 5% of the net weight as "the same thing" - labels
 *  round, so an exact match isn't realistic to require. */
const SINGLE_SERVE_TOLERANCE = 0.05;

export function suggestLabelServing(label: LabelSizeFields): LabelServingSuggestion {
  const { serving_grams, servings_per_package, net_weight_grams } = label;

  const derivedContainer =
    serving_grams > 0 && servings_per_package > 0 ? serving_grams * servings_per_package : null;
  const containerGrams = net_weight_grams > 0 ? net_weight_grams : derivedContainer;

  const singleServe =
    servings_per_package === 1 ||
    (serving_grams > 0 &&
      net_weight_grams > 0 &&
      Math.abs(serving_grams - net_weight_grams) / net_weight_grams < SINGLE_SERVE_TOLERANCE);

  if (singleServe) {
    const grams = serving_grams > 0 ? serving_grams : net_weight_grams > 0 ? net_weight_grams : 100;
    return { isWholeContainer: true, defaultGrams: grams, unitGrams: grams, containerGrams: grams };
  }

  // Multi-serving, or nothing about package size stated at all: ask in units of the
  // declared serving if there is one, else the label's own per-100g basis. Default
  // quantity is one unit - a conservative starting point, not an assumption you ate
  // the whole package.
  const unitGrams = serving_grams > 0 ? serving_grams : 100;
  return { isWholeContainer: false, defaultGrams: unitGrams, unitGrams, containerGrams };
}
