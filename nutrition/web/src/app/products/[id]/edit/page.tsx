"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/useSession";
import NavPill from "@/components/NavPill";
import SignIn from "@/components/SignIn";

interface Per100g {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  // Retained but not user-facing here - nothing downstream (Again, barcode logging,
  // the estimate route) reads these three, so there's no form field for them. They
  // must still be preserved on save rather than silently dropped from the stored JSON.
  sugars_g?: number;
  saturated_fat_g?: number;
  sodium_mg?: number;
}

interface ProductRow {
  id: string;
  user_id: string | null;
  name: string;
  name_he: string | null;
  per_100g: Per100g;
  serving_grams: number | null;
  serving_label: string | null;
  source: string;
}

/**
 * Corrects a scanned product's own record - its name, per-100g macros, and serving
 * size - as opposed to correcting one day's logged amount (that's the portion chips
 * on Today, or the "log serving" prompt for a fresh label scan). Editing here fixes it
 * for every future Again tile and barcode hit of the same item, not just today's entry.
 *
 * Reachable from the small pencil affordance on each Again tile.
 */
export default function EditProductPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { userId, loading } = useSession();

  const [product, setProduct] = useState<ProductRow | null>(null);
  const [name, setName] = useState("");
  const [calories, setCalories] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [fiber, setFiber] = useState("");
  const [servingGrams, setServingGrams] = useState("");
  const [servingLabel, setServingLabel] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !id) return;
    browserClient()
      .from("products")
      .select("id, user_id, name, name_he, per_100g, serving_grams, serving_label, source")
      .eq("id", id)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) {
          setNotFound(true);
          return;
        }
        const p = data as ProductRow;
        setProduct(p);
        setName(p.name);
        setCalories(String(p.per_100g.calories ?? ""));
        setProtein(String(p.per_100g.protein_g ?? ""));
        setCarbs(String(p.per_100g.carbs_g ?? ""));
        setFat(String(p.per_100g.fat_g ?? ""));
        setFiber(String(p.per_100g.fiber_g ?? ""));
        setServingGrams(p.serving_grams != null ? String(p.serving_grams) : "");
        setServingLabel(p.serving_label ?? "");
      });
  }, [userId, id]);

  const isOwner = product && userId && product.user_id === userId;
  const canSave = isOwner && name.trim().length > 0;

  async function save() {
    if (!product || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      const num = (s: string, fallback = 0) => (s.trim() === "" ? fallback : parseFloat(s));
      const { error: updErr } = await browserClient()
        .from("products")
        .update({
          name: name.trim(),
          per_100g: {
            ...product.per_100g, // preserves sugars_g / saturated_fat_g / sodium_mg
            calories: num(calories),
            protein_g: num(protein),
            carbs_g: num(carbs),
            fat_g: num(fat),
            fiber_g: num(fiber),
          },
          serving_grams: servingGrams.trim() === "" ? null : parseFloat(servingGrams),
          serving_label: servingLabel.trim() || null,
        })
        .eq("id", product.id);
      if (updErr) throw new Error(updErr.message);
      router.push("/again");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Soft delete: sets `hidden` rather than removing the row. A hard delete would set
   * every entry that links to this product back to product_id = null (the FK's
   * on-delete rule), and the next Again load would just re-detect the same recurring
   * food/voice dish and recreate it - for a food_repeat item specifically, deleting it
   * would undo itself within one page load. Hiding it is what actually stays gone.
   */
  async function removeFromAgain() {
    if (!product || !isOwner) return;
    setRemoving(true);
    setError(null);
    try {
      const { error: updErr } = await browserClient()
        .from("products")
        .update({ hidden: true })
        .eq("id", product.id);
      if (updErr) throw new Error(updErr.message);
      router.push("/again");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRemoving(false);
    }
  }

  if (loading) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!userId) return <SignIn />;
  if (notFound) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-6">
        <p className="text-sm text-neutral-500">Product not found.</p>
        <NavPill href="/again" label="Back to Again" />
      </div>
    );
  }
  if (!product) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;

  return (
    <div className="flex flex-1 flex-col gap-5 p-4 pb-safe">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Edit dish</h1>
        <NavPill href="/again" label="Cancel" />
      </header>

      {!isOwner && (
        <p className="rounded-xl bg-amber-950/50 p-3 text-xs text-amber-200">
          This is a shared product, not one of yours - it can&apos;t be edited here.
        </p>
      )}

      <p className="text-xs text-neutral-500">
        Fixes this product itself - every future Again tile and barcode scan of this
        item uses these numbers. To correct just one day&apos;s log, use the portion
        chips on that entry instead.
      </p>

      <div className="space-y-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!isOwner}
          placeholder="Dish name"
          className="w-full rounded-2xl border border-ink-line bg-ink-soft p-4
                     placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none
                     disabled:opacity-60"
        />

        <div className="grid grid-cols-5 gap-1">
          {(
            [
              [calories, setCalories, "kcal"],
              [protein, setProtein, "P"],
              [carbs, setCarbs, "C"],
              [fat, setFat, "F"],
              [fiber, setFiber, "fib"],
            ] as const
          ).map(([value, setValue, label]) => (
            <div key={label}>
              <input
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={!isOwner}
                placeholder="0"
                className="w-full rounded-lg border border-ink-line bg-ink-soft p-2 text-center text-sm
                           placeholder:text-neutral-700 focus:border-neutral-500 focus:outline-none
                           disabled:opacity-60"
              />
              <div className="mt-0.5 text-center text-[10px] text-neutral-600">{label}/100g</div>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <input
              type="number"
              value={servingGrams}
              onChange={(e) => setServingGrams(e.target.value)}
              disabled={!isOwner}
              placeholder="e.g. 150"
              className="w-full rounded-xl border border-ink-line bg-ink-soft p-3 text-sm
                         placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none
                         disabled:opacity-60"
            />
            <div className="mt-1 text-[10px] text-neutral-600">
              Serving size (g) - what Again logs by default
            </div>
          </div>
          <div className="flex-1">
            <input
              value={servingLabel}
              onChange={(e) => setServingLabel(e.target.value)}
              disabled={!isOwner}
              placeholder="e.g. 1 container"
              className="w-full rounded-xl border border-ink-line bg-ink-soft p-3 text-sm
                         placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none
                         disabled:opacity-60"
            />
            <div className="mt-1 text-[10px] text-neutral-600">Serving label (optional)</div>
          </div>
        </div>
      </div>

      {error && (
        <p className="rounded-xl bg-red-950/60 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}

      <button
        disabled={saving || removing || !canSave}
        onClick={save}
        className="w-full rounded-2xl bg-neutral-100 py-4 text-lg font-semibold text-ink disabled:opacity-40"
      >
        {saving ? "Saving…" : "Save changes"}
      </button>

      {isOwner && (
        <button
          disabled={saving || removing}
          onClick={removeFromAgain}
          className="min-h-11 w-full text-sm text-red-400 disabled:opacity-40"
        >
          {removing ? "Removing…" : "Remove from Again"}
        </button>
      )}
    </div>
  );
}
