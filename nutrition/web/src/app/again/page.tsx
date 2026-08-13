"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";
import { rankFrequent, detectCombos, comboLabel, detectFrequentUnlinkedDishes, normalizeName } from "@/lib/again";
import { MULTIPLIERS, formatMultiplier } from "@/lib/portions";
import NavPill from "@/components/NavPill";
import PortionChips from "@/components/PortionChips";
import SignIn from "@/components/SignIn";
import { useSession } from "@/lib/useSession";
import type { Entry } from "@/lib/types";

const LONG_PRESS_MS = 500;

interface ProductRow {
  id: string;
  name: string;
  name_he: string | null;
  per_100g: { calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  serving_grams: number | null;
  times_logged: number;
  last_logged_at: string | null;
  recipe_photo_path: string | null;
}

/**
 * The Again screen (plan 4.3) - the app's real retention mechanism. Top products by
 * frequency as one-tap tiles, plus recurring combos as their own tile. After a couple of
 * weeks this should be handling most logs; the tap-through rate here is the metric that
 * actually predicts whether the app keeps getting used.
 */
export default function AgainPage() {
  const router = useRouter();
  const { userId, loading } = useSession();
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [combos, setCombos] = useState<{ ids: string[]; label: string; occurrences: number }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [portionFor, setPortionFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Food-photo and voice logs never get a product_id on their own (api/estimate/route.ts
   * only links label/recipe/barcode/manual sources) - so a home-cooked dish logged
   * repeatedly by photo or voice would otherwise never earn an Again tile no matter how
   * often it recurs. This finds dishes that have crossed that threshold and promotes
   * them into a real product, averaging their macros across occurrences (lib/again.ts).
   * Idempotent: re-checks for an already-promoted product by name before creating a new
   * one, so this is safe to run on every Again load rather than needing its own trigger.
   */
  const promoteFrequentDishes = useCallback(async (uid: string) => {
    const db = browserClient();

    // 180 days, not 60: a repeat homemade dish might recur weekly or biweekly rather
    // than daily, and needs a longer window to accumulate enough occurrences to count.
    const { data: unlinked } = await db
      .from("entries")
      .select("*")
      .eq("user_id", uid)
      .is("product_id", null)
      .in("mode", ["food", "voice"])
      .in("status", ["estimated", "confirmed"])
      .gte("logged_at", new Date(Date.now() - 180 * 86_400_000).toISOString());

    const dishes = detectFrequentUnlinkedDishes((unlinked ?? []) as Entry[]);
    if (dishes.length === 0) return;

    const { data: alreadyPromoted } = await db
      .from("products")
      .select("id, name")
      .eq("user_id", uid)
      .eq("source", "food_repeat");

    for (const dish of dishes) {
      const key = normalizeName(dish.name);
      let productId = (alreadyPromoted ?? []).find((p) => normalizeName(p.name) === key)?.id;

      if (!productId) {
        const { data: created, error: insErr } = await db
          .from("products")
          .insert({
            user_id: uid,
            name: dish.name,
            // sugars_g/saturated_fat_g/sodium_mg have no source here (a photo/voice
            // estimate never produces them) - zeroed rather than omitted, since per_100g
            // is stored as one full JSON object and every consumer expects these keys.
            per_100g: { ...dish.avg, sugars_g: 0, saturated_fat_g: 0, sodium_mg: 0 },
            serving_grams: 100,
            serving_label: `usual portion (avg of ${dish.count} logs)`,
            source: "food_repeat",
            times_logged: dish.count,
            last_logged_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (insErr || !created) continue; // one failure shouldn't block promoting the rest
        productId = created.id;
      }

      // Bring the matched entries in line with every other product-linked entry, so
      // future combo detection and rankFrequent ties treat them the same way.
      await db.from("entries").update({ product_id: productId }).in("id", dish.entryIds).is("product_id", null);
    }
  }, []);

  const load = useCallback(async () => {
    if (!userId) return;
    await promoteFrequentDishes(userId);
    const db = browserClient();

    const [{ data: prods }, { data: recentEntries }] = await Promise.all([
      db
        .from("products")
        .select("id, name, name_he, per_100g, serving_grams, times_logged, last_logged_at, recipe_photo_path")
        .or(`user_id.eq.${userId},user_id.is.null`)
        .gt("times_logged", 0)
        .eq("hidden", false)
        .order("times_logged", { ascending: false })
        .limit(60),
      // Combo detection needs enough history to find real repeats - 60 days is plenty
      // for a pattern that plan 4.3 defines as "at least three times".
      db
        .from("entries")
        .select("*")
        .eq("user_id", userId)
        .not("product_id", "is", null)
        .gte("logged_at", new Date(Date.now() - 60 * 86_400_000).toISOString()),
    ]);

    setProducts((prods ?? []) as ProductRow[]);

    const byId = new Map((prods ?? []).map((p) => [p.id, p.name as string]));
    const found = detectCombos((recentEntries ?? []) as Entry[]);
    setCombos(
      found.map((c) => ({
        ids: c.productIds,
        label: comboLabel(c.productIds.map((id) => byId.get(id) ?? "?")),
        occurrences: c.occurrences,
      }))
    );
  }, [userId, promoteFrequentDishes]);

  useEffect(() => {
    void load();
  }, [load]);

  const ranked = useMemo(() => rankFrequent(products, 24), [products]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  /** Inserts one entry for `p` at `multiplier`. Pure write, no navigation - both the
   *  single-tile tap and the combo tile need to insert several of these in a row
   *  before navigating away once at the end. Returns whether it succeeded, so the
   *  caller can decide whether it's still safe to navigate away. */
  async function insertLog(p: ProductRow, multiplier: number): Promise<boolean> {
    if (!userId) return false;
    const db = browserClient();
    const grams = p.serving_grams || 100;
    const scale = (grams / 100) * multiplier;

    const { error: insErr } = await db.from("entries").insert({
      user_id: userId,
      source: "again",
      mode: null,
      product_id: p.id,
      portion_multiplier: multiplier,
      status: "estimated",
      confidence: "high",
      name: p.name,
      calories: Math.round(p.per_100g.calories * scale),
      protein_g: Math.round(p.per_100g.protein_g * scale),
      carbs_g: Math.round(p.per_100g.carbs_g * scale),
      fat_g: Math.round(p.per_100g.fat_g * scale),
      fiber_g: Math.round(p.per_100g.fiber_g * scale),
    });
    if (insErr) {
      setError(insErr.message);
      return false;
    }
    await db
      .from("products")
      .update({ times_logged: p.times_logged + 1, last_logged_at: new Date().toISOString() })
      .eq("id", p.id);
    return true;
  }

  /** One-tap re-log at the product's default serving. Portion is adjustable afterward
   *  via the same chips used everywhere else (plan 4.3: tap logs immediately, long-press
   *  adjusts portion first - see the pointer handlers below for the long-press logic). */
  async function logProduct(p: ProductRow, multiplier = 1) {
    setBusyId(p.id);
    setError(null);
    try {
      if (await insertLog(p, multiplier)) router.push("/");
    } finally {
      setBusyId(null);
    }
  }

  async function logCombo(ids: string[]) {
    setBusyId(ids.join(","));
    setError(null);
    try {
      let allOk = true;
      for (const id of ids) {
        const p = byId.get(id);
        if (p) allOk = (await insertLog(p, 1)) && allOk;
      }
      if (allOk) router.push("/");
    } finally {
      setBusyId(null);
    }
  }

  // ---------------------------------------------------------------------
  // Long-press to open the portion picker, short tap to log immediately.
  //
  // Previously used onContextMenu, which does not reliably fire on long-press on iOS
  // Safari - the "long-press to adjust portion" instruction below could silently not
  // work depending on the device. Plain pointer-event timing works identically on iOS,
  // Android, and desktop (right-click also still works, since a fast pointerdown-then-up
  // pair from a mouse click is just a short tap).
  // ---------------------------------------------------------------------
  const pressState = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  function onPointerDownTile(p: ProductRow) {
    pressState.current = {
      id: p.id,
      timer: setTimeout(() => {
        setPortionFor(p.id);
        pressState.current = null; // consumed as a long-press - the eventual pointerup must not also log a tap
      }, LONG_PRESS_MS),
    };
  }
  function onPointerUpTile(p: ProductRow) {
    if (pressState.current?.id !== p.id) return; // already consumed by the long-press timer above
    clearTimeout(pressState.current.timer);
    pressState.current = null;
    void logProduct(p);
  }
  function onPointerLeaveTile(p: ProductRow) {
    if (pressState.current?.id !== p.id) return;
    clearTimeout(pressState.current.timer);
    pressState.current = null;
  }

  if (loading) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!userId) return <SignIn />;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 pb-safe">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Again</h1>
        <NavPill href="/" />
      </header>

      {combos.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
            Recent combos
          </h2>
          <div className="flex flex-col gap-2">
            {combos.map((c) => (
              <button
                key={c.ids.join(",")}
                disabled={busyId === c.ids.join(",")}
                onClick={() => logCombo(c.ids)}
                className="flex min-h-11 items-center justify-between rounded-2xl bg-ink-soft px-4
                           py-3 text-left text-sm disabled:opacity-40"
              >
                <span>{c.label}</span>
                <span className="text-xs text-neutral-500">{c.occurrences}× logged together</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Most logged</h2>
        {ranked.length === 0 ? (
          <p className="py-10 text-center text-sm text-neutral-600">
            Nothing here yet — log a few meals and they&apos;ll start showing up for
            one-tap re-logging.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {ranked.map((p) => (
              <div key={p.id} className="relative">
                <button
                  disabled={busyId === p.id}
                  onPointerDown={() => onPointerDownTile(p)}
                  onPointerUp={() => onPointerUpTile(p)}
                  onPointerLeave={() => onPointerLeaveTile(p)}
                  className="flex aspect-square w-full flex-col items-center justify-center
                             gap-1 rounded-2xl bg-ink-soft p-2 text-center disabled:opacity-40"
                >
                  <span className="line-clamp-2 text-xs leading-tight">{p.name}</span>
                  <span className="text-[10px] text-neutral-500">
                    {p.per_100g.calories
                      ? Math.round(p.per_100g.calories * ((p.serving_grams || 100) / 100))
                      : "—"}{" "}
                    kcal
                  </span>
                </button>

                {/* Corrects the product itself (name, macros, serving size) rather than
                    one day's logged amount - see products/[id]/edit. Deliberately under
                    the app's usual 44px tap-target rule: this is a secondary, infrequent
                    action on a 3-column grid, and a full-size target here would eat
                    enough of the tile to make the primary tap-to-log unreliable. */}
                <Link
                  href={`/products/${p.id}/edit`}
                  className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center
                             rounded-full text-[13px] text-neutral-400"
                  aria-label={`Edit ${p.name}`}
                >
                  ✎
                </Link>

                {portionFor === p.id && (
                  <div className="absolute inset-x-0 top-full z-10 mt-1 rounded-xl bg-ink-line p-1">
                    <PortionChips
                      options={MULTIPLIERS.map((m) => ({ label: formatMultiplier(m), value: m }))}
                      onPick={(m) => {
                        setPortionFor(null);
                        void logProduct(p, m);
                      }}
                      allowCustom
                      onCustom={(m) => {
                        setPortionFor(null);
                        void logProduct(p, m);
                      }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-center text-[11px] text-neutral-600">
          Tap to log at the usual portion. Hold to pick a different portion first.
        </p>
      </section>

      <p className="text-center text-xs text-neutral-500">
        Dish not here yet?{" "}
        <Link href="/recipes/new" className="underline">
          Weigh a new dish
        </Link>
      </p>

      {error && (
        <p className="rounded-xl bg-red-950/60 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
