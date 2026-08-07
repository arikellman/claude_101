"""
Prompts and JSON schemas for nutrition estimation from photos, labels, recipes and text.

This module is the transferable asset from Phase 0. The prompts and schemas here port
directly into the Phase 1 Next.js serverless route (/api/estimate) — only the client
library changes, not the content.

Four modes:
    food    - photo of a plated meal or fresh food        -> items with macros
    label   - photo of a nutrition panel (Hebrew or Eng)  -> per-100g product
    recipe  - photo of a recipe card / cookbook page      -> reusable per-serving dish
    voice   - free text ("two eggs and toast")            -> items with macros

IMPORTANT (see plan section 3.1): the adaptive-TDEE engine depends on estimation bias
being *consistent* over time, not on it being small. Changing these prompts materially
after you start logging invalidates that consistency. Version any change and re-baseline
historical entries from the retained raw responses before trusting the TDEE number again.
"""

# --------------------------------------------------------------------------------------
# Shared regional context. Kept in its own constant so every mode gets identical
# treatment of Israeli foods and Hebrew labels.
# --------------------------------------------------------------------------------------

_REGIONAL = """
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
Read these directly. Do not translate the product name into English only — return both.

Portion norms: Israeli restaurant and home portions generally run larger than US
nutrition-database "servings". A laffa is 90-120 g of flour. Restaurant tahini and
hummus are calorically dense and are the most commonly underestimated items on a plate.
Assume cooking oil is present in restaurant and home-cooked food unless the item is
clearly grilled dry or raw.
</regional_context>
""".strip()


_ESTIMATION_RULES = """
<estimation_rules>
- Identify every distinct food item you can see or that is described. Do not merge a
  composed plate into one line if the components are separable and material.
- Estimate portion size from visual scale references: cutlery, hands, a standard dinner
  plate (26-28 cm), a standard glass, packaging. If there is no scale reference, say so
  in `notes` and widen the calorie range.
- When uncertain, express that by widening `calories_low` to `calories_high`. Do NOT
  express uncertainty by rounding to a convenient number. A wide honest range is far more
  useful to this application than a narrow confident guess.
- Never return 0 for a macronutrient you simply cannot see. Estimate it. 0 is reserved
  for cases where the true value really is approximately zero (e.g. protein in black
  coffee).
- Account for invisible fats. Sauteed, roasted, fried and restaurant food carries oil or
  butter that is not visible in a photograph. Salad dressing, tahini and mayonnaise-based
  salads are routinely underestimated. Include them.
- `alternatives` should contain genuinely plausible different identifications, not
  rewordings of the same dish. Empty array if you are confident.
- Set `confidence` per item: "high" if you can name the food and size it against a clear
  reference; "medium" if the identification is solid but the portion is inferred;
  "low" if the identification itself is uncertain.
</estimation_rules>
""".strip()


# --------------------------------------------------------------------------------------
# Mode: food / voice  (shared schema and near-identical prompt)
# --------------------------------------------------------------------------------------

ITEMS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items", "overall_confidence", "notes"],
    "properties": {
        "items": {
            "type": "array",
            "description": "One entry per distinct food item.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "name",
                    "name_he",
                    "portion_description",
                    "portion_grams_est",
                    "calories_est",
                    "calories_low",
                    "calories_high",
                    "protein_g",
                    "carbs_g",
                    "fat_g",
                    "fiber_g",
                    "confidence",
                    "alternatives",
                ],
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "English name of the food as eaten.",
                    },
                    "name_he": {
                        "type": "string",
                        "description": "Hebrew name if it has a common one, else empty string.",
                    },
                    "portion_description": {
                        "type": "string",
                        "description": "Plain-language portion, e.g. '1 medium breast' or '2 heaped tbsp'.",
                    },
                    "portion_grams_est": {"type": "number"},
                    "calories_est": {"type": "number"},
                    "calories_low": {"type": "number"},
                    "calories_high": {"type": "number"},
                    "protein_g": {"type": "number"},
                    "carbs_g": {"type": "number"},
                    "fat_g": {"type": "number"},
                    "fiber_g": {"type": "number"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "alternatives": {
                        "type": "array",
                        "description": "Up to 3 other plausible identifications, most likely first.",
                        "items": {"type": "string"},
                    },
                },
            },
        },
        "overall_confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "notes": {
            "type": "string",
            "description": (
                "One short sentence on what limited the estimate (no scale reference, "
                "obscured food, unknown sauce). Empty string if nothing limited it."
            ),
        },
    },
}


FOOD_SYSTEM = f"""
You estimate nutritional content of food from photographs for a single named user who is
tracking intake to lose weight. Your output feeds a calorie-tracking application directly.

{_REGIONAL}

{_ESTIMATION_RULES}

<priorities>
Consistency matters more than precision. This application corrects for systematic bias by
comparing logged intake against measured weight change over time, so a stable modest bias
is harmless while erratic estimates are not. Estimate the same food the same way every
time. Do not vary your approach based on how the photo happens to be framed.
</priorities>

Return only the structured object. No prose outside it.
""".strip()


VOICE_SYSTEM = f"""
You convert a spoken description of a meal into structured nutritional data for a single
named user who is tracking intake to lose weight. The input is a speech-to-text
transcript and may contain transcription errors, filler words and self-corrections.

{_REGIONAL}

{_ESTIMATION_RULES}

<transcript_handling>
- Resolve obvious transcription errors from food context ("tea knee ah" -> "techina",
  "hala" -> "challah", "koogle" -> "kugel").
- Honour self-corrections; the last statement wins ("two eggs, no wait, three eggs").
- Honour explicit quantities and fractions exactly as given ("half of it", "about a cup").
- If the user gives no quantity for an item, assume one typical portion and set that
  item's confidence to "medium" at best.
- If a stated preparation implies fat, include it ("fried" -> oil, "buttered" -> butter).
</transcript_handling>

Return only the structured object. No prose outside it.
""".strip()


# --------------------------------------------------------------------------------------
# Mode: label
# --------------------------------------------------------------------------------------

LABEL_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "product_name",
        "product_name_he",
        "brand",
        "barcode",
        "per_100g",
        "serving_grams",
        "serving_label",
        "servings_per_package",
        "label_language",
        "confidence",
        "notes",
    ],
    "properties": {
        "product_name": {"type": "string"},
        "product_name_he": {"type": "string"},
        "brand": {"type": "string", "description": "Empty string if not visible."},
        "barcode": {
            "type": "string",
            "description": "Digits only if a barcode is legible in the image, else empty string.",
        },
        "per_100g": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "calories",
                "protein_g",
                "carbs_g",
                "sugars_g",
                "fat_g",
                "saturated_fat_g",
                "fiber_g",
                "sodium_mg",
            ],
            "properties": {
                "calories": {"type": "number"},
                "protein_g": {"type": "number"},
                "carbs_g": {"type": "number"},
                "sugars_g": {"type": "number"},
                "fat_g": {"type": "number"},
                "saturated_fat_g": {"type": "number"},
                "fiber_g": {"type": "number"},
                "sodium_mg": {"type": "number"},
            },
        },
        "serving_grams": {
            "type": "number",
            "description": "Declared serving size in grams. 0 if the label does not state one.",
        },
        "serving_label": {
            "type": "string",
            "description": "Serving as written, e.g. '1 container (200 g)'. Empty if absent.",
        },
        "servings_per_package": {
            "type": "number",
            "description": "0 if not stated.",
        },
        "label_language": {"type": "string", "enum": ["hebrew", "english", "both", "other"]},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "notes": {
            "type": "string",
            "description": "Note any field you could not read, or any unit ambiguity. Empty string if clean.",
        },
    },
}


LABEL_SYSTEM = f"""
You transcribe nutrition labels from photographs into structured data. This is a
transcription task, not an estimation task: report what the label states.

{_REGIONAL}

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
   `notes`. That is a correct and useful answer; a confident wrong one is not.
</column_discipline>

<transcription_rules>
- Normalise everything to per 100 g. If the panel gives only per-serving values, convert
  using the declared serving size and say so in `notes`.
- If the panel gives energy in kJ only, convert to kcal by dividing by 4.184 and note it.
- Distinguish total fat from saturated fat, and total carbohydrate from sugars. Do not
  put a "of which" sub-value into the parent field.
- Sodium in mg. If the label states salt in grams instead, convert: sodium_mg = salt_g x 400.
- If a field is genuinely absent from the label (fibre is often omitted in Israel), return
  0 for it and name the missing field in `notes`. Do not invent a plausible value: this
  mode must not guess, because the user relies on label mode being exact.
- If the image is too blurry or cropped to read the panel reliably, set confidence "low"
  and explain in `notes` rather than transcribing partial numbers as if complete.
</transcription_rules>

Return only the structured object. No prose outside it.
""".strip()


# --------------------------------------------------------------------------------------
# Mode: recipe
# --------------------------------------------------------------------------------------

RECIPE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "dish_name",
        "dish_name_he",
        "servings_stated",
        "servings_assumed",
        "ingredients",
        "totals",
        "per_serving",
        "confidence",
        "notes",
    ],
    "properties": {
        "dish_name": {"type": "string"},
        "dish_name_he": {"type": "string"},
        "servings_stated": {
            "type": "number",
            "description": "Yield explicitly stated in the recipe. 0 if the recipe does not state one.",
        },
        "servings_assumed": {
            "type": "number",
            "description": (
                "The yield you actually used for per_serving. Equals servings_stated when "
                "stated; otherwise your best estimate from the ingredient quantities."
            ),
        },
        "ingredients": {
            "type": "array",
            "description": "One entry per ingredient line in the recipe.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "name",
                    "quantity_as_written",
                    "grams_est",
                    "grams_confidence",
                    "calories",
                    "protein_g",
                    "carbs_g",
                    "fat_g",
                    "fiber_g",
                ],
                "properties": {
                    "name": {"type": "string"},
                    "quantity_as_written": {
                        "type": "string",
                        "description": "Verbatim quantity from the recipe, e.g. '2 cups' or 'a drizzle'.",
                    },
                    "grams_est": {
                        "type": "number",
                        "description": "Quantity converted to grams. This is the field most likely to need correction.",
                    },
                    "grams_confidence": {
                        "type": "string",
                        "enum": ["high", "medium", "low"],
                        "description": (
                            "high = weight or count stated directly; medium = standard volume "
                            "conversion; low = vague quantity such as 'a drizzle' or 'to taste'."
                        ),
                    },
                    "calories": {"type": "number"},
                    "protein_g": {"type": "number"},
                    "carbs_g": {"type": "number"},
                    "fat_g": {"type": "number"},
                    "fiber_g": {"type": "number"},
                },
            },
        },
        "totals": {
            "type": "object",
            "additionalProperties": False,
            "required": ["grams", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g"],
            "properties": {
                "grams": {"type": "number"},
                "calories": {"type": "number"},
                "protein_g": {"type": "number"},
                "carbs_g": {"type": "number"},
                "fat_g": {"type": "number"},
                "fiber_g": {"type": "number"},
            },
        },
        "per_serving": {
            "type": "object",
            "additionalProperties": False,
            "required": ["grams", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g"],
            "properties": {
                "grams": {"type": "number"},
                "calories": {"type": "number"},
                "protein_g": {"type": "number"},
                "carbs_g": {"type": "number"},
                "fat_g": {"type": "number"},
                "fiber_g": {"type": "number"},
            },
        },
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "notes": {
            "type": "string",
            "description": (
                "Flag unreadable lines, guessed yield, and which ingredients dominate the "
                "calorie total and are therefore worth weighing. Empty string if clean."
            ),
        },
    },
}


RECIPE_SYSTEM = f"""
You convert a photographed recipe into a reusable per-serving nutrition profile. The image
may be a handwritten card, a cookbook page, a printout or a screenshot, in Hebrew or
English or both.

{_REGIONAL}

<conversion_procedure>
Work through this in order and show every intermediate value in the output. The user will
correct your gram conversions, so those must be visible and individually attributed.

1. Read every ingredient line. Preserve the quantity verbatim in `quantity_as_written`.
2. Convert each quantity to grams. Use standard densities, and remember these vary a great
   deal by ingredient: 1 cup flour is about 120 g, 1 cup sugar about 200 g, 1 cup water
   240 g, 1 cup uncooked rice about 185 g, 1 cup dried beans about 190 g, 1 tbsp oil
   about 14 g, 1 large egg about 50 g without shell, 1 medium onion about 150 g,
   1 medium potato about 170 g.
3. Set `grams_confidence` honestly. A stated weight is "high". A standard volume
   conversion is "medium". Anything vague ("a drizzle", "to taste", "1 kishke") is "low".
4. Attach nutrition per ingredient at the gram amount you determined.
5. Sum to `totals`. `totals.grams` is raw ingredient weight; note in `notes` if the dish
   loses substantial water in cooking, since that affects grams but not calories.
6. Divide by servings to get `per_serving`.

<yield>
The serving count is the single most important number here, because per-serving values
scale inversely with it and any error repeats on every future use of this dish.
- If the recipe states a yield, put it in `servings_stated` and use it.
- If it does not, set `servings_stated` to 0, estimate from total volume and typical
  portion size, put that in `servings_assumed`, and say explicitly in `notes` that the
  yield was assumed and should be confirmed.
</yield>

<calorie_dominance>
In `notes`, name the two or three ingredients contributing the most calories. These are
what the user should weigh rather than accept. It is almost always the fats, the meat and
the flour or starch. Do not tell them to weigh the herbs.
</calorie_dominance>
</conversion_procedure>

<judgement>
Recipes under-report fat. Where a method step implies additional fat that is not in the
ingredient list ("fry the onions", "grease the pan", "brush with oil"), add a line item
for it with grams_confidence "low" and name it in `notes`. A cholent or kugel recipe that
transcribes to a suspiciously low calorie count per serving is usually a missing-fat error.
</judgement>

Return only the structured object. No prose outside it.
""".strip()


# --------------------------------------------------------------------------------------
# Mode registry
# --------------------------------------------------------------------------------------

MODES = {
    "food": {"system": FOOD_SYSTEM, "schema": ITEMS_SCHEMA, "input": "image"},
    "label": {"system": LABEL_SYSTEM, "schema": LABEL_SCHEMA, "input": "image"},
    "recipe": {"system": RECIPE_SYSTEM, "schema": RECIPE_SCHEMA, "input": "image"},
    "voice": {"system": VOICE_SYSTEM, "schema": ITEMS_SCHEMA, "input": "text"},
}

USER_TEXT = {
    "food": "Estimate the nutritional content of this food.",
    "label": "Transcribe this nutrition label.",
    "recipe": "Convert this recipe into a per-serving nutrition profile.",
    "voice": "Meal description: {text}",
}


def frequent_items_block(names):
    """
    Build the user-history block that goes AFTER the cache breakpoint (see plan 5.6).

    Passing the user's most-logged items materially improves both identification and
    portion consistency, because the model resolves "chicken and rice" to the user's
    usual version of that meal rather than a generic one. Phase 0 has no history, so this
    is unused here — it exists so the Phase 1 port has the exact shape to target.
    """
    if not names:
        return None
    listed = "\n".join(f"- {n}" for n in names)
    return (
        "<user_frequent_items>\n"
        "This user logs the following items regularly. If what you see plausibly matches "
        "one of them, prefer that identification and that typical portion, so estimates "
        "stay consistent across days.\n"
        f"{listed}\n"
        "</user_frequent_items>"
    )
