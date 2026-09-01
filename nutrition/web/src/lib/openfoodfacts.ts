/**
 * Open Food Facts lookup (plan 5.1, Path A). Free, no key, no rate limit worth
 * worrying about.
 *
 * This is deliberately the FIRST path tried on a barcode hit and the one most likely
 * to fail: Israeli supermarket coverage is thin (plan 5.1), so a miss here is the
 * expected case, not an error. The caller falls through to Path B (label photo) on
 * a miss - see BarcodeScan.tsx.
 */

import type { Per100g } from "./types";

export interface OffProduct {
  name: string;
  brand: string;
  per100g: Per100g;
}

interface OffResponse {
  status: number;
  product?: {
    product_name?: string;
    product_name_he?: string;
    brands?: string;
    nutriments?: Record<string, number>;
  };
}

/** Returns null on a miss (no product, or no usable nutrition data) - never throws for that. */
export async function lookupBarcode(barcode: string): Promise<OffProduct | null> {
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`);
  if (!res.ok) throw new Error(`Open Food Facts returned ${res.status}`);

  const data = (await res.json()) as OffResponse;
  if (data.status !== 1 || !data.product) return null;

  const n = data.product.nutriments ?? {};
  // OFF's "_100g" suffixed fields are already normalised to per-100g, matching this
  // app's internal unit throughout (products.per_100g).
  const calories = n["energy-kcal_100g"];
  const protein = n["proteins_100g"];
  if (calories === undefined || protein === undefined) return null; // too sparse to trust

  return {
    name: data.product.product_name || data.product.product_name_he || "Unnamed product",
    brand: data.product.brands ?? "",
    per100g: {
      calories,
      protein_g: protein,
      carbs_g: n["carbohydrates_100g"] ?? 0,
      sugars_g: n["sugars_100g"] ?? 0,
      fat_g: n["fat_100g"] ?? 0,
      saturated_fat_g: n["saturated-fat_100g"] ?? 0,
      fiber_g: n["fiber_100g"] ?? 0,
      sodium_mg: n["sodium_100g"] !== undefined ? n["sodium_100g"] * 1000 : 0,
    },
  };
}
