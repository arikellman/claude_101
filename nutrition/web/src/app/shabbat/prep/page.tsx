"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { browserClient } from "@/lib/supabase/client";
import { fetchZmanim, fridayOf } from "@/lib/hebcal";
import { useSession } from "@/lib/useSession";
import NavPill from "@/components/NavPill";
import SignIn from "@/components/SignIn";
import type { MealSlot } from "@/lib/types";

const SLOTS: { id: MealSlot; label: string }[] = [
  { id: "friday_dinner", label: "Friday dinner" },
  { id: "kiddush", label: "Kiddush" },
  { id: "shabbat_lunch", label: "Shabbat lunch" },
  { id: "seudah_shlishit", label: "Seudah shlishit" },
];

interface Product {
  id: string;
  name: string;
  per_100g: { calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  serving_grams: number | null;
  source: string;
}

interface PlanRow {
  id: string;
  week_start: string;
  candle_lighting: string | null;
  havdalah: string | null;
}

interface SavedEntry {
  id: string;
  meal_slot: MealSlot;
  name: string;
  calories: number | null;
}

/**
 * Friday-afternoon Shabbat Prep screen (plan 10.2, 10.1).
 *
 * This is the single most important screen in the Shabbat handling, because it converts
 * Saturday night from "reconstruct 25 hours of eating from memory" into "adjust portions
 * on a list that already exists" - recall of deviation from a known plan beats recall of
 * absolutes by a wide margin. Build the menu now, while the phone still works.
 */
export default function ShabbatPrepPage() {
  const { userId, loading } = useSession();
  const [plan, setPlan] = useState<PlanRow | null>(null);
  const [dishes, setDishes] = useState<Product[]>([]);
  const [assignments, setAssignments] = useState<Record<MealSlot, string[]>>({
    friday_dinner: [],
    kiddush: [],
    shabbat_lunch: [],
    seudah_shlishit: [],
  });
  const [savedEntries, setSavedEntries] = useState<SavedEntry[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const db = browserClient();
    const weekStart = fridayOf(new Date());

    let { data: existing } = await db
      .from("shabbat_plans")
      .select("id, week_start, candle_lighting, havdalah")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle();

    if (!existing) {
      const { data: settings } = await db
        .from("settings")
        .select("geonameid")
        .eq("user_id", userId)
        .maybeSingle();
      const z = await fetchZmanim(settings?.geonameid ?? 293397, weekStart);
      const { data: created, error: upErr } = await db
        .from("shabbat_plans")
        .upsert(
          {
            user_id: userId,
            week_start: weekStart,
            candle_lighting: z.candleLighting?.toISOString() ?? null,
            havdalah: z.havdalah?.toISOString() ?? null,
            is_yomtov: z.isYomTov,
          },
          { onConflict: "user_id,week_start" }
        )
        .select("id, week_start, candle_lighting, havdalah")
        .single();
      if (upErr) setError(upErr.message);
      existing = created;
    }
    setPlan(existing ?? null);

    // Dishes eligible for the menu: anything with a saved per-100g profile, weighted
    // toward the standing repertoire (recipe_ocr / recipe_manual) but not limited to it -
    // any product, including a barcode-scanned item, can go on the Shabbat table.
    const { data: prods } = await db
      .from("products")
      .select("id, name, per_100g, serving_grams, source")
      .or(`user_id.eq.${userId},user_id.is.null`)
      .eq("hidden", false)
      .order("times_logged", { ascending: false })
      .limit(40);
    setDishes((prods ?? []) as Product[]);

    if (existing) {
      const { data: alreadySaved } = await db
        .from("entries")
        .select("id, meal_slot, name, calories")
        .eq("shabbat_plan_id", existing.id)
        .eq("status", "pending");
      if (alreadySaved?.length) setSavedEntries(alreadySaved as SavedEntry[]);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(slot: MealSlot, productId: string) {
    setAssignments((a) => {
      const current = a[slot];
      const next = current.includes(productId)
        ? current.filter((id) => id !== productId)
        : [...current, productId];
      return { ...a, [slot]: next };
    });
  }

  const hasAssignment = Object.values(assignments).some((list) => list.length > 0);

  /**
   * Timestamp a pre-logged item lands at for a given slot. Not "now" (that would put a
   * Friday-afternoon pre-log into Friday afternoon's food list, before it's even been
   * eaten) - each slot gets a plausible time within the actual Shabbat window, and the
   * user can correct it during reconciliation. Backdating is first-class (plan 10.2).
   */
  function timeForSlot(slot: MealSlot): Date {
    const candle = plan?.candle_lighting ? new Date(plan.candle_lighting) : new Date();
    const havdalah = plan?.havdalah ? new Date(plan.havdalah) : new Date();
    switch (slot) {
      case "friday_dinner":
        return new Date(candle.getTime() + 30 * 60_000);
      case "kiddush":
        return new Date(havdalah);
      case "shabbat_lunch": {
        const d = new Date(havdalah);
        d.setHours(13, 0, 0, 0);
        return d;
      }
      case "seudah_shlishit":
        return new Date(havdalah.getTime() - 90 * 60_000);
    }
  }

  async function savePlan() {
    if (!userId || !plan || !hasAssignment) return;
    setSaving(true);
    setError(null);
    try {
      const db = browserClient();
      const rows = SLOTS.flatMap(({ id: slot }) =>
        assignments[slot].map((productId) => {
          const p = dishes.find((d) => d.id === productId)!;
          const grams = p.serving_grams || 100;
          const scale = grams / 100;
          return {
            user_id: userId,
            source: "manual" as const,
            mode: null,
            product_id: p.id,
            meal_slot: slot,
            shabbat_plan_id: plan.id,
            status: "pending" as const, // per plan 10.2: exists, but doesn't count until confirmed
            confidence: "high" as const,
            logged_at: timeForSlot(slot).toISOString(),
            name: p.name,
            calories: Math.round(p.per_100g.calories * scale),
            protein_g: Math.round(p.per_100g.protein_g * scale),
            carbs_g: Math.round(p.per_100g.carbs_g * scale),
            fat_g: Math.round(p.per_100g.fat_g * scale),
            fiber_g: Math.round(p.per_100g.fiber_g * scale),
          };
        })
      );

      const { data: inserted, error: insErr } = await db.from("entries").insert(rows).select();
      if (insErr) throw new Error(insErr.message);
      setSavedEntries((prev) => [...(prev ?? []), ...((inserted ?? []) as SavedEntry[])]);
      setAssignments({ friday_dinner: [], kiddush: [], shabbat_lunch: [], seudah_shlishit: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  /** "Guest at someone else's table" - a generic Shabbat meal template rather than
   *  precision that isn't achievable when someone else is cooking (plan 10.2, 10.4 #7:
   *  "don't attempt precision... log generously, deliberately overestimate by ~15%"). */
  async function useGuestTemplate() {
    if (!userId || !plan) return;
    setSaving(true);
    setError(null);
    try {
      const db = browserClient();
      // Deliberately generous (plan 10.4 #7: an honest overestimate beats a hopeful
      // guess, because the TDEE engine punishes inconsistency, not error).
      const GUEST_TEMPLATE: { slot: MealSlot; name: string; calories: number; protein_g: number; carbs_g: number; fat_g: number }[] = [
        { slot: "friday_dinner", name: "Guest Shabbat dinner (generic estimate)", calories: 950, protein_g: 45, carbs_g: 90, fat_g: 40 },
        { slot: "shabbat_lunch", name: "Guest Shabbat lunch (generic estimate)", calories: 1050, protein_g: 40, carbs_g: 110, fat_g: 45 },
        { slot: "seudah_shlishit", name: "Guest seudah shlishit (generic estimate)", calories: 350, protein_g: 15, carbs_g: 40, fat_g: 12 },
      ];
      const rows = GUEST_TEMPLATE.map((t) => ({
        user_id: userId,
        source: "manual" as const,
        mode: null,
        product_id: null,
        meal_slot: t.slot,
        shabbat_plan_id: plan.id,
        status: "pending" as const,
        confidence: "low" as const,
        low_confidence: true,
        logged_at: timeForSlot(t.slot).toISOString(),
        name: t.name,
        calories: t.calories,
        protein_g: t.protein_g,
        carbs_g: t.carbs_g,
        fat_g: t.fat_g,
        fiber_g: 5,
      }));
      const { data: inserted, error: insErr } = await db.from("entries").insert(rows).select();
      if (insErr) throw new Error(insErr.message);
      setSavedEntries((prev) => [...(prev ?? []), ...((inserted ?? []) as SavedEntry[])]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const savedBySlot = useMemo(() => {
    const by = new Map<MealSlot, SavedEntry[]>();
    for (const e of savedEntries ?? []) by.set(e.meal_slot, [...(by.get(e.meal_slot) ?? []), e]);
    return by;
  }, [savedEntries]);

  if (loading) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!userId) return <SignIn />;

  return (
    <div className="flex flex-1 flex-col gap-5 p-4 pb-safe">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Shabbat Prep</h1>
        <NavPill href="/" />
      </header>

      {plan?.candle_lighting && (
        <p className="text-xs text-neutral-500">
          Candles {new Date(plan.candle_lighting).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}
          {" · "}
          Havdalah {plan.havdalah && new Date(plan.havdalah).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}
        </p>
      )}

      {savedEntries && savedEntries.length > 0 && (
        <section className="space-y-3 rounded-2xl bg-ink-soft p-4">
          <p className="text-sm font-semibold">
            {savedEntries.length} item{savedEntries.length === 1 ? "" : "s"} planned.
          </p>
          <p className="text-xs text-neutral-400">
            Doesn&apos;t count toward your budget yet — confirm portions Saturday night
            on Wrap-up.
          </p>
          {SLOTS.map(({ id: slot, label }) =>
            savedBySlot.has(slot) ? (
              <div key={slot}>
                <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
                <ul className="text-sm text-neutral-300">
                  {savedBySlot.get(slot)!.map((e) => (
                    <li key={e.id} className="flex justify-between py-0.5">
                      <span>{e.name}</span>
                      <span className="text-neutral-500">{e.calories} kcal</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          )}
        </section>
      )}

      <p className="text-xs text-neutral-500">
        Tap the dishes you&apos;re serving into each meal. Not there yet?{" "}
        <Link href="/recipes/new" className="underline">
          Weigh a new dish
        </Link>{" "}
        or use Food/Recipe mode from Home once it&apos;s plated.
      </p>

      {SLOTS.map(({ id: slot, label }) => (
        <section key={slot}>
          <h2 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">{label}</h2>
          <div className="flex flex-wrap gap-2">
            {dishes.length === 0 && (
              <p className="text-xs text-neutral-600">No saved dishes yet.</p>
            )}
            {dishes.map((d) => {
              const active = assignments[slot].includes(d.id);
              return (
                <button
                  key={d.id}
                  onClick={() => toggle(slot, d.id)}
                  className={`min-h-11 rounded-full px-3 text-xs ${
                    active ? "bg-neutral-100 font-semibold text-ink" : "bg-ink-soft text-neutral-400"
                  }`}
                >
                  {d.name}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {error && (
        <p className="rounded-xl bg-red-950/60 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}

      <div className="space-y-2">
        <button
          disabled={saving || !hasAssignment}
          onClick={savePlan}
          className="w-full rounded-2xl bg-neutral-100 py-4 text-lg font-semibold text-ink disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save plan"}
        </button>
        <button
          disabled={saving}
          onClick={useGuestTemplate}
          className="w-full rounded-2xl bg-ink-soft py-3 text-sm text-neutral-300 disabled:opacity-40"
        >
          Guest at someone else&apos;s table instead
        </button>
      </div>
    </div>
  );
}
