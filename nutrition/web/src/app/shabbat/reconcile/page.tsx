"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/useSession";
import { useDeferredDelete } from "@/lib/useDeferredDelete";
import NavPill from "@/components/NavPill";
import PortionChips from "@/components/PortionChips";
import SignIn from "@/components/SignIn";
import UndoBanner from "@/components/UndoBanner";
import type { Entry, MealSlot } from "@/lib/types";

const SLOT_LABEL: Record<MealSlot, string> = {
  friday_dinner: "Friday dinner",
  kiddush: "Kiddush",
  shabbat_lunch: "Shabbat lunch",
  seudah_shlishit: "Seudah shlishit",
};

const CHIPS: { label: string; value: number | "skipped" }[] = [
  { label: "skipped", value: "skipped" },
  { label: "½×", value: 0.5 },
  { label: "1×", value: 1 },
  { label: "2×", value: 2 },
  { label: "3×", value: 3 },
];

/** More than this long after havdalah, recall has degraded enough to flag honestly
 *  rather than trust it silently (plan 10.2's "decay honesty"). */
const LATE_HOURS = 24;

/**
 * Saturday-night reconciliation (plan 10.2). The payoff for the Friday pre-log: this is
 * "adjust portions on a list that's already there," not "reconstruct 25 hours from
 * memory." If the plan was right, confirming the entire Shabbat is one tap.
 */
export default function ReconcilePage() {
  const { userId, loading } = useSession();
  const [plan, setPlan] = useState<{ id: string; havdalah: string | null } | null>(null);
  const [items, setItems] = useState<Entry[]>([]);
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const db = browserClient();

    const { data: latestPlan } = await db
      .from("shabbat_plans")
      .select("id, havdalah")
      .eq("user_id", userId)
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latestPlan) return;
    setPlan(latestPlan);

    const { data: entries } = await db
      .from("entries")
      .select("*")
      .eq("shabbat_plan_id", latestPlan.id)
      .eq("status", "pending")
      .order("meal_slot");
    setItems((entries ?? []) as Entry[]);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // "skipped" deletes the row - the one destructive action on this screen, so it gets
  // the same undo-window treatment as everywhere else instead of vanishing on one tap.
  const { pending: pendingDelete, stage, undo } = useDeferredDelete<Entry>(async (entry) => {
    const { error: delErr } = await browserClient().from("entries").delete().eq("id", entry.id);
    if (delErr) setError(delErr.message);
    await closeOutPlanIfDone();
  });

  const isLate = useMemo(() => {
    if (!plan?.havdalah) return false;
    return Date.now() - new Date(plan.havdalah).getTime() > LATE_HOURS * 3_600_000;
  }, [plan]);

  const visibleItems = useMemo(
    () => items.filter((e) => e.id !== pendingDelete?.id),
    [items, pendingDelete]
  );

  const grouped = useMemo(() => {
    const by = new Map<MealSlot, Entry[]>();
    for (const e of visibleItems) {
      if (!e.meal_slot) continue;
      by.set(e.meal_slot, [...(by.get(e.meal_slot) ?? []), e]);
    }
    return by;
  }, [visibleItems]);

  async function resolveEntry(entry: Entry, choice: number | "skipped") {
    if (choice === "skipped") {
      stage(entry);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const base = entry.portion_multiplier || 1;
      const k = choice / base;
      const scale = (v: number | null) => (v == null ? null : Math.round(v * k));

      // Decay honesty (plan 10.2): reconciled more than 24h after havdalah gets flagged
      // and its range widened, rather than trusted at face value like a same-night confirm.
      const widen = isLate ? 1.25 : 1;
      const calories = scale(entry.calories);

      const { error: updErr } = await browserClient()
        .from("entries")
        .update({
          status: "confirmed",
          portion_multiplier: choice,
          user_corrected: choice !== 1,
          reconciled_at: new Date().toISOString(),
          low_confidence: isLate,
          calories,
          protein_g: scale(entry.protein_g),
          carbs_g: scale(entry.carbs_g),
          fat_g: scale(entry.fat_g),
          fiber_g: scale(entry.fiber_g),
          calories_low: calories != null ? Math.round(calories / widen) : null,
          calories_high: calories != null ? Math.round(calories * widen) : null,
        })
        .eq("id", entry.id);
      if (updErr) throw new Error(updErr.message);
      await load();
      await closeOutPlanIfDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAllAsPlanned() {
    setBusy(true);
    setError(null);
    try {
      const db = browserClient();
      const widen = isLate ? 1.25 : 1;
      for (const e of visibleItems) {
        const calories = e.calories;
        const { error: updErr } = await db
          .from("entries")
          .update({
            status: "confirmed",
            reconciled_at: new Date().toISOString(),
            low_confidence: isLate,
            calories_low: calories != null ? Math.round(calories / widen) : null,
            calories_high: calories != null ? Math.round(calories * widen) : null,
          })
          .eq("id", e.id);
        if (updErr) throw new Error(updErr.message);
      }
      await load();
      await closeOutPlanIfDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function closeOutPlanIfDone() {
    if (!plan || !userId) return;
    const db = browserClient();
    const { count } = await db
      .from("entries")
      .select("*", { count: "exact", head: true })
      .eq("shabbat_plan_id", plan.id)
      .eq("status", "pending");
    // Stops the havdalah+2h re-fire and Sunday fallback (lib/shabbatSchedule.ts checks
    // this column) the moment every item has a real answer, planned or not.
    if ((count ?? 0) === 0) {
      await db.from("shabbat_plans").update({ reconciled_at: new Date().toISOString() }).eq("id", plan.id);
    }
  }

  /** "Ate something not on the plan" (plan 10.2) - Saturday night is exactly when voice
   *  shines, so this drops straight into the same voice pipeline Home uses, without
   *  making the user navigate away from the screen they're already reconciling on. */
  async function logExtra() {
    if (!userId || !extra.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const db = browserClient();
      const { data: entry, error: insErr } = await db
        .from("entries")
        .insert({
          user_id: userId,
          source: "voice",
          mode: "voice",
          raw_input: extra,
          status: "pending",
          low_confidence: isLate,
        })
        .select("id")
        .single();
      if (insErr || !entry) throw new Error(insErr?.message ?? "insert failed");

      fetch("/api/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId: entry.id, userId, mode: "voice", text: extra }),
      }).catch(() => {});

      setExtra("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!userId) return <SignIn />;

  return (
    <div className="flex flex-1 flex-col gap-5 p-4 pb-safe">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Shabbat wrap-up</h1>
        <NavPill href="/" />
      </header>

      {isLate && (
        <p className="rounded-xl bg-ink-soft p-3 text-xs text-neutral-400">
          It&apos;s been over 24 hours since havdalah — recall fades fast, so these will
          be logged with a wider range rather than trusted exactly.
        </p>
      )}

      {visibleItems.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-600">
          {plan
            ? "Nothing pending reconciliation. Everything from this Shabbat is already confirmed."
            : "No Shabbat plan found yet - visit Shabbat Prep on Friday afternoon to pre-log the menu."}
        </p>
      ) : (
        <>
          <button
            disabled={busy}
            onClick={confirmAllAsPlanned}
            className="w-full rounded-2xl bg-neutral-100 py-4 text-lg font-semibold text-ink disabled:opacity-40"
          >
            Confirm everything as planned
          </button>

          {(["friday_dinner", "kiddush", "shabbat_lunch", "seudah_shlishit"] as MealSlot[]).map(
            (slot) =>
              grouped.has(slot) && (
                <section key={slot}>
                  <h2 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
                    {SLOT_LABEL[slot]}
                  </h2>
                  <div className="space-y-2">
                    {grouped.get(slot)!.map((e) => (
                      <div key={e.id} className="rounded-2xl bg-ink-soft p-3">
                        <div className="mb-2 flex justify-between text-sm">
                          <span>{e.name}</span>
                          <span className="text-neutral-500">{e.calories} kcal planned</span>
                        </div>
                        <PortionChips
                          options={CHIPS}
                          disabled={busy}
                          onPick={(v) => resolveEntry(e, v)}
                          allowCustom
                          onCustom={(m) => resolveEntry(e, m)}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              )
          )}
        </>
      )}

      <section className="space-y-2">
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">
          Ate something not on the plan?
        </h2>
        <textarea
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="also had two pieces of cake at the neighbors and a bowl of chips"
          rows={2}
          className="w-full rounded-2xl border border-ink-line bg-ink-soft p-4 text-sm
                     placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <button
          disabled={busy || !extra.trim()}
          onClick={logExtra}
          className="w-full rounded-2xl bg-ink-line py-3 text-sm font-semibold text-neutral-200 disabled:opacity-40"
        >
          Log it
        </button>
      </section>

      {error && (
        <p className="rounded-xl bg-red-950/60 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}

      <UndoBanner visible={!!pendingDelete} label="Marked skipped" onUndo={undo} />
    </div>
  );
}
