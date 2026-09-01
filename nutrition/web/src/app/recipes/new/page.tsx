"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/useSession";
import NavPill from "@/components/NavPill";
import SignIn from "@/components/SignIn";

interface IngredientRow {
  key: string;
  name: string;
  grams: string;
  caloriesPer100g: string;
  proteinPer100g: string;
  carbsPer100g: string;
  fatPer100g: string;
  fiberPer100g: string;
  /** "high" once weighed with a scale (plan 5.4) - this whole screen exists so that
   *  can be true by default, unlike the photo path where it's usually "medium". */
  gramsConfidence: "high" | "medium" | "low";
}

interface KnownProduct {
  id: string;
  name: string;
  per_100g: { calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
}

function emptyRow(): IngredientRow {
  return {
    key: crypto.randomUUID(),
    name: "",
    grams: "",
    caloriesPer100g: "",
    proteinPer100g: "",
    carbsPer100g: "",
    fatPer100g: "",
    fiberPer100g: "",
    gramsConfidence: "high",
  };
}

/**
 * Manual recipe builder - the weigh-as-you-cook path (plan 10.3), complementing the
 * photo path (Path R, §5.4). More accurate than a photo because every gram is measured
 * as it happens rather than inferred afterward; less likely to actually get used, which
 * is why the photo path exists as the faster first resort. Build your standing Shabbat
 * repertoire here once and it's a one-tap Again tile forever after.
 */
export default function NewRecipePage() {
  const router = useRouter();
  const { userId, loading } = useSession();
  const [dishName, setDishName] = useState("");
  const [servings, setServings] = useState("8");
  const [rows, setRows] = useState<IngredientRow[]>([emptyRow(), emptyRow()]);
  const [known, setKnown] = useState<KnownProduct[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    browserClient()
      .from("products")
      .select("id, name, per_100g")
      .eq("hidden", false)
      .order("times_logged", { ascending: false })
      .limit(100)
      .then(({ data }) => setKnown((data ?? []) as KnownProduct[]));
  }, []);

  function updateRow(key: string, patch: Partial<IngredientRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function pickKnown(key: string, productId: string) {
    const p = known.find((k) => k.id === productId);
    if (!p) return;
    updateRow(key, {
      name: p.name,
      caloriesPer100g: String(p.per_100g.calories),
      proteinPer100g: String(p.per_100g.protein_g),
      carbsPer100g: String(p.per_100g.carbs_g),
      fatPer100g: String(p.per_100g.fat_g),
      fiberPer100g: String(p.per_100g.fiber_g),
      gramsConfidence: "high",
    });
  }

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        const g = parseFloat(r.grams) || 0;
        const scale = g / 100;
        return {
          grams: acc.grams + g,
          calories: acc.calories + (parseFloat(r.caloriesPer100g) || 0) * scale,
          protein_g: acc.protein_g + (parseFloat(r.proteinPer100g) || 0) * scale,
          carbs_g: acc.carbs_g + (parseFloat(r.carbsPer100g) || 0) * scale,
          fat_g: acc.fat_g + (parseFloat(r.fatPer100g) || 0) * scale,
          fiber_g: acc.fiber_g + (parseFloat(r.fiberPer100g) || 0) * scale,
        };
      },
      { grams: 0, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }
    );
  }, [rows]);

  const usableRows = rows.filter((r) => r.name.trim() && parseFloat(r.grams) > 0);
  const canSave = dishName.trim().length > 0 && usableRows.length > 0;

  const servingsNum = Math.max(1, parseFloat(servings) || 1);
  const perServing = {
    grams: totals.grams / servingsNum,
    calories: totals.calories / servingsNum,
    protein_g: totals.protein_g / servingsNum,
    carbs_g: totals.carbs_g / servingsNum,
    fat_g: totals.fat_g / servingsNum,
    fiber_g: totals.fiber_g / servingsNum,
  };

  async function save() {
    if (!userId || !canSave) return;
    const usable = usableRows;

    setSaving(true);
    setError(null);
    try {
      const db = browserClient();
      const round1 = (n: number) => Math.round(n * 10) / 10;
      const recipeRaw = {
        dish_name: dishName,
        dish_name_he: "",
        servings_stated: servingsNum,
        servings_assumed: servingsNum,
        ingredients: usable.map((r) => ({
          name: r.name,
          quantity_as_written: `${r.grams} g (weighed)`,
          grams_est: parseFloat(r.grams),
          grams_confidence: r.gramsConfidence,
          calories: round1((parseFloat(r.caloriesPer100g) || 0) * (parseFloat(r.grams) / 100)),
          protein_g: round1((parseFloat(r.proteinPer100g) || 0) * (parseFloat(r.grams) / 100)),
          carbs_g: round1((parseFloat(r.carbsPer100g) || 0) * (parseFloat(r.grams) / 100)),
          fat_g: round1((parseFloat(r.fatPer100g) || 0) * (parseFloat(r.grams) / 100)),
          fiber_g: round1((parseFloat(r.fiberPer100g) || 0) * (parseFloat(r.grams) / 100)),
        })),
        totals: { grams: round1(totals.grams), calories: round1(totals.calories), protein_g: round1(totals.protein_g), carbs_g: round1(totals.carbs_g), fat_g: round1(totals.fat_g), fiber_g: round1(totals.fiber_g) },
        per_serving: { grams: round1(perServing.grams), calories: round1(perServing.calories), protein_g: round1(perServing.protein_g), carbs_g: round1(perServing.carbs_g), fat_g: round1(perServing.fat_g), fiber_g: round1(perServing.fiber_g) },
        confidence: "high" as const,
        notes: "Weighed while cooking - see plan 10.3.",
      };

      const per100gScale = totals.grams > 0 ? 100 / totals.grams : 0;
      const { error: insErr } = await db.from("products").insert({
        user_id: userId,
        name: dishName,
        per_100g: {
          calories: round1(totals.calories * per100gScale),
          protein_g: round1(totals.protein_g * per100gScale),
          carbs_g: round1(totals.carbs_g * per100gScale),
          sugars_g: 0,
          fat_g: round1(totals.fat_g * per100gScale),
          saturated_fat_g: 0,
          fiber_g: round1(totals.fiber_g * per100gScale),
          sodium_mg: 0,
        },
        serving_grams: round1(perServing.grams),
        serving_label: `1 of ${servingsNum} servings`,
        source: "recipe_manual",
        recipe_raw: recipeRaw,
      });
      if (insErr) throw new Error(insErr.message);

      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!userId) return <SignIn />;

  return (
    <div className="flex flex-1 flex-col gap-5 p-4 pb-safe">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New dish</h1>
        <NavPill href="/" label="Cancel" />
      </header>

      <p className="text-xs text-neutral-500">
        Weigh ingredients as you cook and enter them here. Pick a saved product to
        auto-fill its per-100g values, or type them from a label. This is more accurate
        than the recipe-photo path because nothing is estimated.
      </p>

      <div className="space-y-3">
        <input
          value={dishName}
          onChange={(e) => setDishName(e.target.value)}
          placeholder="Dish name — e.g. Cholent"
          className="w-full rounded-2xl border border-ink-line bg-ink-soft p-4
                     placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <div className="flex items-center gap-3">
          <label className="text-sm text-neutral-400">Servings</label>
          <input
            type="number"
            min="1"
            value={servings}
            onChange={(e) => setServings(e.target.value)}
            className="w-20 rounded-xl border border-ink-line bg-ink-soft p-2 text-center"
          />
          <span className="text-xs text-neutral-600">
            The highest-leverage field here — per-serving values scale inversely with it.
          </span>
        </div>
      </div>

      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.key} className="space-y-2 rounded-2xl bg-ink-soft p-3">
            <div className="flex gap-2">
              <input
                value={r.name}
                onChange={(e) => updateRow(r.key, { name: e.target.value })}
                placeholder="Ingredient"
                className="flex-1 rounded-xl border border-ink-line bg-ink p-2 text-sm
                           placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
              />
              <input
                type="number"
                value={r.grams}
                onChange={(e) => updateRow(r.key, { grams: e.target.value })}
                placeholder="grams"
                className="w-20 rounded-xl border border-ink-line bg-ink p-2 text-sm
                           placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
              />
            </div>

            {known.length > 0 && (
              <select
                onChange={(e) => e.target.value && pickKnown(r.key, e.target.value)}
                defaultValue=""
                className="w-full rounded-xl border border-ink-line bg-ink p-2 text-xs text-neutral-400"
              >
                <option value="">— or fill from a saved product —</option>
                {known.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}

            <div className="grid grid-cols-5 gap-1">
              {(
                [
                  ["caloriesPer100g", "kcal"],
                  ["proteinPer100g", "P"],
                  ["carbsPer100g", "C"],
                  ["fatPer100g", "F"],
                  ["fiberPer100g", "fib"],
                ] as const
              ).map(([field, label]) => (
                <div key={field}>
                  <input
                    type="number"
                    value={r[field]}
                    onChange={(e) => updateRow(r.key, { [field]: e.target.value })}
                    placeholder="0"
                    className="w-full rounded-lg border border-ink-line bg-ink p-1.5 text-center text-xs
                               placeholder:text-neutral-700 focus:border-neutral-500 focus:outline-none"
                  />
                  <div className="mt-0.5 text-center text-[10px] text-neutral-600">{label}/100g</div>
                </div>
              ))}
            </div>

            <button
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              className="min-h-11 px-1 text-xs text-neutral-500"
            >
              Remove
            </button>
          </div>
        ))}

        <button
          onClick={() => setRows((rs) => [...rs, emptyRow()])}
          className="w-full rounded-2xl border border-dashed border-ink-line py-3 text-sm text-neutral-400"
        >
          + Add ingredient
        </button>
      </div>

      <div className="rounded-2xl bg-ink-soft p-4 text-sm">
        <div className="mb-1 text-xs uppercase tracking-wide text-neutral-500">Per serving</div>
        <div className="flex justify-between">
          <span>{Math.round(perServing.calories)} kcal</span>
          <span className="text-macro-protein">{Math.round(perServing.protein_g)}g P</span>
          <span className="text-macro-carbs">{Math.round(perServing.carbs_g)}g C</span>
          <span className="text-macro-fat">{Math.round(perServing.fat_g)}g F</span>
        </div>
      </div>

      {error && (
        <p className="rounded-xl bg-red-950/60 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}

      <button
        disabled={saving || !canSave}
        onClick={save}
        className="w-full rounded-2xl bg-neutral-100 py-4 text-lg font-semibold text-ink disabled:opacity-40"
      >
        {saving ? "Saving…" : "Save dish"}
      </button>
    </div>
  );
}
