/** Shared types mirroring the Supabase schema and the Claude response shapes. */

import type { Mode } from "./prompts";

export type { Mode };

export type EntryStatus = "pending" | "estimated" | "confirmed" | "failed";
export type EntrySource =
  | "photo" | "barcode" | "label" | "recipe" | "voice" | "again" | "manual";
export type MealSlot =
  | "friday_dinner" | "kiddush" | "shabbat_lunch" | "seudah_shlishit";
export type Confidence = "high" | "medium" | "low";

export interface Entry {
  id: string;
  user_id: string;
  logged_at: string;
  created_at: string;
  source: EntrySource;
  mode: Mode | null;
  photo_path: string | null;
  raw_input: string | null;
  status: EntryStatus;
  product_id: string | null;
  portion_multiplier: number;
  meal_slot: MealSlot | null;
  shabbat_plan_id: string | null;
  reconciled_at: string | null;
  ai_model: string | null;
  ai_raw: unknown;
  confidence: Confidence | null;
  low_confidence: boolean;
  name: string | null;
  calories: number | null;
  calories_low: number | null;
  calories_high: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  user_corrected: boolean;
}

/** Claude's response shape for food and voice modes. */
export interface EstimatedItem {
  name: string;
  name_he: string;
  portion_description: string;
  portion_grams_est: number;
  calories_est: number;
  calories_low: number;
  calories_high: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  confidence: Confidence;
  alternatives: string[];
}

export interface ItemsResult {
  items: EstimatedItem[];
  overall_confidence: Confidence;
  notes: string;
}

export interface Per100g {
  calories: number;
  protein_g: number;
  carbs_g: number;
  sugars_g: number;
  fat_g: number;
  saturated_fat_g: number;
  fiber_g: number;
  sodium_mg: number;
}

export interface LabelResult {
  product_name: string;
  product_name_he: string;
  brand: string;
  barcode: string;
  per_100g: Per100g;
  serving_grams: number;
  serving_label: string;
  servings_per_package: number;
  label_language: "hebrew" | "english" | "both" | "other";
  confidence: Confidence;
  notes: string;
}

export interface RecipeIngredient {
  name: string;
  quantity_as_written: string;
  grams_est: number;
  grams_confidence: Confidence;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
}

export interface MacroBlock {
  grams: number;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
}

export interface RecipeResult {
  dish_name: string;
  dish_name_he: string;
  servings_stated: number;
  servings_assumed: number;
  ingredients: RecipeIngredient[];
  totals: MacroBlock;
  per_serving: MacroBlock;
  confidence: Confidence;
  notes: string;
}

export type EstimateResult = ItemsResult | LabelResult | RecipeResult;

/** Totals across items, scaled by the entry's portion multiplier. */
export function sumItems(items: EstimatedItem[], multiplier = 1) {
  const acc = {
    calories: 0, calories_low: 0, calories_high: 0,
    protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0,
  };
  for (const i of items) {
    acc.calories += i.calories_est;
    acc.calories_low += i.calories_low;
    acc.calories_high += i.calories_high;
    acc.protein_g += i.protein_g;
    acc.carbs_g += i.carbs_g;
    acc.fat_g += i.fat_g;
    acc.fiber_g += i.fiber_g;
  }
  return Object.fromEntries(
    Object.entries(acc).map(([k, v]) => [k, Math.round(v * multiplier)])
  ) as typeof acc;
}
