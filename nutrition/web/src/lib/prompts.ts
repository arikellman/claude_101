/**
 * Prompts and JSON schemas for nutrition estimation. Ported verbatim from the Phase 0
 * harness (../../prompts.py).
 *
 * ============================ DO NOT CASUALLY EDIT ============================
 * The adaptive-TDEE engine in lib/nutrition.ts solves for expenditure from the
 * relationship between logged intake and measured weight change, which means it absorbs a
 * CONSISTENT estimation bias and cancels it out of your target. Materially changing these
 * prompts silently redefines the unit your calorie targets are denominated in, and the
 * failure is very hard to notice from the outside.
 *
 * If you must change them: bump PROMPT_VERSION, and re-run history through the new prompt
 * from the retained entries.ai_raw column so the series stays continuous.
 * =============================================================================
 */

export const PROMPT_VERSION = "2026-08-06.1";

export type Mode = "food" | "label" | "recipe" | "voice";

/**
 * Model per mode. Settled by an A/B of both models over the same 6 photos on 2026-08-06.
 *
 * Label mode stays on Opus 5 because Sonnet 5 swapped the per-100g and per-container
 * columns on a Hebrew Tnuva yogurt panel - every macro exactly 2x high, a fabricated
 * serving size to justify it, "medium" confidence, no flag - while transcribing two other
 * labels perfectly. That makes the error layout-dependent and therefore erratic, which
 * adaptive TDEE cannot absorb, and label results are cached into `products` and reused
 * forever, so one bad transcription poisons every future log of that product.
 *
 * Mixing models across modes does NOT break the consistency rule above: that rule governs
 * estimation, where a bias must stay stable. Label mode is transcription against printed
 * ground truth - there is no bias, only right and wrong. Each mode must stay on one model.
 */
export const MODEL_BY_MODE: Record<Mode, string> = {
  food: "claude-sonnet-5",
  recipe: "claude-sonnet-5",
  voice: "claude-sonnet-5",
  label: "claude-opus-5",
};

// ---------------------------------------------------------------------------
// Shared blocks
// ---------------------------------------------------------------------------

const REGIONAL = `
<regional_context>
The user lives in Israel. Expect Israeli, Middle Eastern and Ashkenazi/Sephardi Jewish
foods, and expect packaging and recipes in Hebrew as often as English.

Common items to recognise by name: hummus, tahini (techina), labneh, shakshuka, sabich,
laffa, pita, bourekas, schnitzel, ptitim (Israeli couscous), Israeli salad, malawach,
jachnun, chraime, kubbeh, cholent/chamin, potato kugel, lokshen kugel, challah, matzah
balls (kneidlach), gefilte fish, kishke, rugelach, krembo, bamba.

Common brands: Tnuva, Osem, Strauss, Elite, Telma, Prigat, Tara, Yotvata, Shufersal
house brands, Rami Levy house brands, Angel and Berman bakeries.

Hebrew nutrition labels: the standard Israeli panel is titled "ערכים תזונתיים" and gives
values per 100 g (ל-100 גרם) and often per serving (למנה). Field names you will see:
  קלוריות / אנרגיה = calories/energy      חלבונים = protein
  פחמימות = carbohydrates                 מתוכן סוכרים = of which sugars
  שומנים / שומן = fat                     מתוכן שומן רווי = of which saturated fat
  סיבים תזונתיים = dietary fibre           נתרן = sodium
  גודל מנה = serving size                  מנות באריזה = servings per package
Read these directly. Do not translate the product name into English only - return both.

Portion norms: Israeli restaurant and home portions generally run larger than US
nutrition-database "servings". A laffa is 90-120 g of flour. Restaurant tahini and
hummus are calorically dense and are the most commonly underestimated items on a plate.
Assume cooking oil is present in restaurant and home-cooked food unless the item is
clearly grilled dry or raw.
</regional_context>`.trim();

const ESTIMATION_RULES = `
<estimation_rules>
- Identify every distinct food item you can see or that is described. Do not merge a
  composed plate into one line if the components are separable and material.
- Estimate portion size from visual scale references: cutlery, hands, a standard dinner
  plate (26-28 cm), a standard glass, packaging. If there is no scale reference, say so
  in \`notes\` and widen the calorie range.
- When uncertain, express that by widening \`calories_low\` to \`calories_high\`. Do NOT
  express uncertainty by rounding to a convenient number. A wide honest range is far more
  useful to this application than a narrow confident guess.
- Never return 0 for a macronutrient you simply cannot see. Estimate it. 0 is reserved
  for cases where the true value really is approximately zero (e.g. protein in black
  coffee).
- Account for invisible fats. Sauteed, roasted, fried and restaurant food carries oil or
  butter that is not visible in a photograph. Salad dressing, tahini and mayonnaise-based
  salads are routinely underestimated. Include them.
- \`alternatives\` should contain genuinely plausible different identifications, not
  rewordings of the same dish. Empty array if you are confident.
- Set \`confidence\` per item: "high" if you can name the food and size it against a clear
  reference; "medium" if the identification is solid but the portion is inferred;
  "low" if the identification itself is uncertain.
</estimation_rules>`.trim();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const num = { type: "number" } as const;
const str = { type: "string" } as const;
const conf = { type: "string", enum: ["high", "medium", "low"] } as const;

export const ITEMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "overall_confidence", "notes"],
  properties: {
    items: {
      type: "array",
      description: "One entry per distinct food item.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name", "name_he", "portion_description", "portion_grams_est",
          "calories_est", "calories_low", "calories_high",
          "protein_g", "carbs_g", "fat_g", "fiber_g",
          "confidence", "alternatives",
        ],
        properties: {
          name: { ...str, description: "English name of the food as eaten." },
          name_he: { ...str, description: "Hebrew name if it has a common one, else empty string." },
          portion_description: {
            ...str,
            description: "Plain-language portion, e.g. '1 medium breast' or '2 heaped tbsp'.",
          },
          portion_grams_est: num,
          calories_est: num,
          calories_low: num,
          calories_high: num,
          protein_g: num,
          carbs_g: num,
          fat_g: num,
          fiber_g: num,
          confidence: conf,
          alternatives: {
            type: "array",
            description: "Up to 3 other plausible identifications, most likely first.",
            items: str,
          },
        },
      },
    },
    overall_confidence: conf,
    notes: {
      ...str,
      description:
        "One short sentence on what limited the estimate (no scale reference, obscured " +
        "food, unknown sauce). Empty string if nothing limited it.",
    },
  },
} as const;

export const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "product_name", "product_name_he", "brand", "barcode", "per_100g",
    "serving_grams", "serving_label", "servings_per_package",
    "label_language", "confidence", "notes",
  ],
  properties: {
    product_name: str,
    product_name_he: str,
    brand: { ...str, description: "Empty string if not visible." },
    barcode: {
      ...str,
      description: "Digits only if a barcode is legible in the image, else empty string.",
    },
    per_100g: {
      type: "object",
      additionalProperties: false,
      required: [
        "calories", "protein_g", "carbs_g", "sugars_g",
        "fat_g", "saturated_fat_g", "fiber_g", "sodium_mg",
      ],
      properties: {
        calories: num, protein_g: num, carbs_g: num, sugars_g: num,
        fat_g: num, saturated_fat_g: num, fiber_g: num, sodium_mg: num,
      },
    },
    serving_grams: {
      ...num,
      description: "Declared serving size in grams. 0 if the label does not state one.",
    },
    serving_label: {
      ...str,
      description: "Serving as written, e.g. '1 container (200 g)'. Empty if absent.",
    },
    servings_per_package: { ...num, description: "0 if not stated." },
    label_language: { type: "string", enum: ["hebrew", "english", "both", "other"] },
    confidence: conf,
    notes: {
      ...str,
      description:
        "Note any field you could not read, or any unit ambiguity. Empty string if clean.",
    },
  },
} as const;

const macroBlock = {
  type: "object",
  additionalProperties: false,
  required: ["grams", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g"],
  properties: {
    grams: num, calories: num, protein_g: num,
    carbs_g: num, fat_g: num, fiber_g: num,
  },
} as const;

export const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "dish_name", "dish_name_he", "servings_stated", "servings_assumed",
    "ingredients", "totals", "per_serving", "confidence", "notes",
  ],
  properties: {
    dish_name: str,
    dish_name_he: str,
    servings_stated: {
      ...num,
      description: "Yield explicitly stated in the recipe. 0 if the recipe does not state one.",
    },
    servings_assumed: {
      ...num,
      description:
        "The yield you actually used for per_serving. Equals servings_stated when stated; " +
        "otherwise your best estimate from the ingredient quantities.",
    },
    ingredients: {
      type: "array",
      description: "One entry per ingredient line in the recipe.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name", "quantity_as_written", "grams_est", "grams_confidence",
          "calories", "protein_g", "carbs_g", "fat_g", "fiber_g",
        ],
        properties: {
          name: str,
          quantity_as_written: {
            ...str,
            description: "Verbatim quantity from the recipe, e.g. '2 cups' or 'a drizzle'.",
          },
          grams_est: {
            ...num,
            description:
              "Quantity converted to grams. This is the field most likely to need correction.",
          },
          grams_confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description:
              "high = weight or count stated directly; medium = standard volume " +
              "conversion; low = vague quantity such as 'a drizzle' or 'to taste'.",
          },
          calories: num, protein_g: num, carbs_g: num, fat_g: num, fiber_g: num,
        },
      },
    },
    totals: macroBlock,
    per_serving: macroBlock,
    confidence: conf,
    notes: {
      ...str,
      description:
        "Flag unreadable lines, guessed yield, and which ingredients dominate the calorie " +
        "total and are therefore worth weighing. Empty string if clean.",
    },
  },
} as const;

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const FOOD_SYSTEM = `
You estimate nutritional content of food from photographs for a single named user who is
tracking intake to lose weight. Your output feeds a calorie-tracking application directly.

${REGIONAL}

${ESTIMATION_RULES}

<priorities>
Consistency matters more than precision. This application corrects for systematic bias by
comparing logged intake against measured weight change over time, so a stable modest bias
is harmless while erratic estimates are not. Estimate the same food the same way every
time. Do not vary your approach based on how the photo happens to be framed.
</priorities>

Return only the structured object. No prose outside it.`.trim();

const VOICE_SYSTEM = `
You convert a spoken description of a meal into structured nutritional data for a single
named user who is tracking intake to lose weight. The input is a speech-to-text
transcript and may contain transcription errors, filler words and self-corrections.

${REGIONAL}

${ESTIMATION_RULES}

<transcript_handling>
- Resolve obvious transcription errors from food context ("tea knee ah" -> "techina",
  "hala" -> "challah", "koogle" -> "kugel").
- Honour self-corrections; the last statement wins ("two eggs, no wait, three eggs").
- Honour explicit quantities and fractions exactly as given ("half of it", "about a cup").
- If the user gives no quantity for an item, assume one typical portion and set that
  item's confidence to "medium" at best.
- If a stated preparation implies fat, include it ("fried" -> oil, "buttered" -> butter).
</transcript_handling>

Return only the structured object. No prose outside it.`.trim();

const LABEL_SYSTEM = `
You transcribe nutrition labels from photographs into structured data. This is a
transcription task, not an estimation task: report what the label states.

${REGIONAL}

<column_discipline>
Israeli panels very often carry TWO numeric columns: one per 100 g and one per serving or
per container (למנה or בגביע). Getting these the wrong way round produces an error of
exactly the ratio between them - typically 2x - which is the single worst failure mode in
this mode, because the result is cached and reused indefinitely.

Before reporting any number:
1. Read the panel's own header. The Israeli standard header states the per-100 g basis
   explicitly ("סימון תזונתי ב-100 גרם מזון"). The per-serving or per-container column is
   the one with its own separate heading, e.g. בגביע or למנה.
2. Hebrew reads right to left, so in a Hebrew panel the column NEAREST the row labels is
   normally the first column, and the leftmost column is the additional one. Do not assume
   left-to-right ordering.
3. Sanity-check the result against physical plausibility. Yogurt with 20 g protein per
   100 g does not exist; 10 g per 100 g is a high-protein yogurt. Cheese at 300 kcal/100 g
   is normal; at 600 it is not. If your per-100 g reading is implausible for the food type,
   you have probably taken the per-container column - re-read the headers.
4. NEVER infer a serving size from the ratio between two columns. If the label does not
   state a serving size, return 0. Deriving a serving size from the ratio is how a column
   swap gets silently rationalised into a self-consistent but wrong answer.
5. If you cannot confidently tell the columns apart, set confidence "low" and say so in
   \`notes\`. That is a correct and useful answer; a confident wrong one is not.
</column_discipline>

<transcription_rules>
- Normalise everything to per 100 g. If the panel gives only per-serving values, convert
  using the declared serving size and say so in \`notes\`.
- If the panel gives energy in kJ only, convert to kcal by dividing by 4.184 and note it.
- Distinguish total fat from saturated fat, and total carbohydrate from sugars. Do not
  put a "of which" sub-value into the parent field.
- Sodium in mg. If the label states salt in grams instead, convert: sodium_mg = salt_g x 400.
- If a field is genuinely absent from the label (fibre is often omitted in Israel), return
  0 for it and name the missing field in \`notes\`. Do not invent a plausible value: this
  mode must not guess, because the user relies on label mode being exact.
- If the image is too blurry or cropped to read the panel reliably, set confidence "low"
  and explain in \`notes\` rather than transcribing partial numbers as if complete.
</transcription_rules>

Return only the structured object. No prose outside it.`.trim();

const RECIPE_SYSTEM = `
You convert a photographed recipe into a reusable per-serving nutrition profile. The image
may be a handwritten card, a cookbook page, a printout or a screenshot, in Hebrew or
English or both.

${REGIONAL}

<conversion_procedure>
Work through this in order and show every intermediate value in the output. The user will
correct your gram conversions, so those must be visible and individually attributed.

1. Read every ingredient line. Preserve the quantity verbatim in \`quantity_as_written\`.
2. Convert each quantity to grams. Use standard densities, and remember these vary a great
   deal by ingredient: 1 cup flour is about 120 g, 1 cup sugar about 200 g, 1 cup water
   240 g, 1 cup uncooked rice about 185 g, 1 cup dried beans about 190 g, 1 tbsp oil
   about 14 g, 1 large egg about 50 g without shell, 1 medium onion about 150 g,
   1 medium potato about 170 g.
3. Set \`grams_confidence\` honestly. A stated weight is "high". A standard volume
   conversion is "medium". Anything vague ("a drizzle", "to taste", "1 kishke") is "low".
4. Attach nutrition per ingredient at the gram amount you determined.
5. Sum to \`totals\`. \`totals.grams\` is raw ingredient weight; note in \`notes\` if the dish
   loses substantial water in cooking, since that affects grams but not calories.
6. Divide by servings to get \`per_serving\`.

<yield>
The serving count is the single most important number here, because per-serving values
scale inversely with it and any error repeats on every future use of this dish.
- If the recipe states a yield, put it in \`servings_stated\` and use it.
- If it does not, set \`servings_stated\` to 0, estimate from total volume and typical
  portion size, put that in \`servings_assumed\`, and say explicitly in \`notes\` that the
  yield was assumed and should be confirmed.
</yield>

<calorie_dominance>
In \`notes\`, name the two or three ingredients contributing the most calories. These are
what the user should weigh rather than accept. It is almost always the fats, the meat and
the flour or starch. Do not tell them to weigh the herbs.
</calorie_dominance>
</conversion_procedure>

<judgement>
Recipes under-report fat. Where a method step implies additional fat that is not in the
ingredient list ("fry the onions", "grease the pan", "brush with oil"), add a line item
for it with grams_confidence "low" and name it in \`notes\`. A cholent or kugel recipe that
transcribes to a suspiciously low calorie count per serving is usually a missing-fat error.
</judgement>

Return only the structured object. No prose outside it.`.trim();

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ModeConfig {
  system: string;
  schema: object;
  input: "image" | "text";
  userText: string;
}

export const MODES: Record<Mode, ModeConfig> = {
  food: {
    system: FOOD_SYSTEM,
    schema: ITEMS_SCHEMA,
    input: "image",
    userText: "Estimate the nutritional content of this food.",
  },
  label: {
    system: LABEL_SYSTEM,
    schema: LABEL_SCHEMA,
    input: "image",
    userText: "Transcribe this nutrition label.",
  },
  recipe: {
    system: RECIPE_SYSTEM,
    schema: RECIPE_SCHEMA,
    input: "image",
    userText: "Convert this recipe into a per-serving nutrition profile.",
  },
  voice: {
    system: VOICE_SYSTEM,
    schema: ITEMS_SCHEMA,
    input: "text",
    userText: "Meal description: ",
  },
};

/**
 * User-history block. Goes AFTER the cache breakpoint so it never invalidates the
 * cached system prefix. Passing frequent items measurably improves both identification
 * and portion CONSISTENCY, which is what the TDEE engine actually depends on.
 */
export function frequentItemsBlock(names: string[]): string | null {
  if (!names.length) return null;
  return [
    "<user_frequent_items>",
    "This user logs the following items regularly. If what you see plausibly matches one",
    "of them, prefer that identification and that typical portion, so estimates stay",
    "consistent across days.",
    ...names.map((n) => `- ${n}`),
    "</user_frequent_items>",
  ].join("\n");
}
