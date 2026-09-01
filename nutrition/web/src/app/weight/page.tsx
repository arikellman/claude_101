"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import { isoDate, kgToLb, lbToKg } from "@/lib/nutrition";
import { useSession } from "@/lib/useSession";
import { useDeferredDelete } from "@/lib/useDeferredDelete";
import NavPill from "@/components/NavPill";
import SignIn from "@/components/SignIn";
import UndoBanner from "@/components/UndoBanner";

type TimeOfDay = "morning" | "afternoon" | "evening";

const TIME_LABEL: Record<TimeOfDay, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

interface WeightRow {
  id: string;
  measured_on: string;
  time_of_day: TimeOfDay;
  weight_kg: number;
}

/** Best guess for which chip is already right, so logging right when you weigh
 *  yourself is usually zero extra taps beyond the number itself. */
function defaultTimeOfDay(): TimeOfDay {
  const h = new Date().getHours();
  if (h < 11) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

/**
 * A plain weight diary. Deliberately does nothing with the data beyond storing and
 * listing it - no trend line, no averaging, no TDEE input. That's the whole point: a
 * place to jot a number down and get it back, with as little friction as possible between
 * "I just stepped off the scale" and "it's logged." Trend now reads this same table for
 * its own weigh-in (see lib/nutrition + trend/page.tsx) - this page's job is unchanged.
 */
export default function WeightLogPage() {
  const { userId, loading } = useSession();
  const [rows, setRows] = useState<WeightRow[]>([]);
  const [weightInput, setWeightInput] = useState("");
  const [date, setDate] = useState(isoDate(new Date()));
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>(defaultTimeOfDay());
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const db = browserClient();
    const { data, error: selErr } = await db
      .from("weight_log")
      .select("id, measured_on, time_of_day, weight_kg")
      .eq("user_id", userId)
      .order("measured_on", { ascending: false })
      .order("created_at", { ascending: false });

    if (selErr) setError(selErr.message);
    const list = (data ?? []) as WeightRow[];
    setRows(list);

    // Pre-fill with the most recent weight: your weight barely moves day to day, and
    // typing the same number from scratch every time is exactly the kind of friction
    // that gets this abandoned. Confirming an unchanged prefill is still a valid entry.
    if (list.length && !weightInput) {
      setWeightInput(kgToLb(list[0].weight_kg).toFixed(1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const { pending: pendingDelete, stage, undo } = useDeferredDelete<WeightRow>(async (row) => {
    const { error: delErr } = await browserClient().from("weight_log").delete().eq("id", row.id);
    if (delErr) setError(delErr.message);
  });

  async function save() {
    const lb = parseFloat(weightInput);
    if (!userId || !Number.isFinite(lb)) return;
    setSaving(true);
    setError(null);
    try {
      const { error: insErr } = await browserClient().from("weight_log").insert({
        user_id: userId,
        measured_on: date,
        time_of_day: timeOfDay,
        weight_kg: lbToKg(lb),
      });
      if (insErr) throw new Error(insErr.message);

      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
      setDate(isoDate(new Date()));
      setTimeOfDay(defaultTimeOfDay());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Group into date-headed sections for scanability - "retrieval" means being able to
  // find a specific day at a glance, not just an undifferentiated flat list.
  const grouped = useMemo(() => {
    const visible = rows.filter((r) => r.id !== pendingDelete?.id);
    const by = new Map<string, WeightRow[]>();
    for (const r of visible) by.set(r.measured_on, [...(by.get(r.measured_on) ?? []), r]);
    return [...by.entries()];
  }, [rows, pendingDelete]);

  if (loading) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!userId) return <SignIn />;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 pb-safe">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Weight</h1>
        <NavPill href="/" />
      </header>

      {/* Entry: the whole point of this screen. Number, date, one chip, save. */}
      <section className="space-y-3 rounded-3xl bg-ink-soft p-4">
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            autoFocus
            value={weightInput}
            onChange={(e) => setWeightInput(e.target.value)}
            placeholder="Weight in lb"
            className="flex-1 rounded-2xl border border-ink-line bg-ink p-4 text-2xl
                       tabular-nums placeholder:text-base placeholder:text-neutral-600
                       focus:border-neutral-500 focus:outline-none"
          />
          <span className="text-sm text-neutral-500">lb</span>
        </div>

        <div className="flex gap-2">
          {(["morning", "afternoon", "evening"] as TimeOfDay[]).map((t) => (
            <button
              key={t}
              onClick={() => setTimeOfDay(t)}
              className={`min-h-11 flex-1 rounded-xl text-sm ${
                timeOfDay === t
                  ? "bg-neutral-100 font-semibold text-ink"
                  : "bg-ink-line text-neutral-300"
              }`}
            >
              {TIME_LABEL[t]}
            </button>
          ))}
        </div>

        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full rounded-xl border border-ink-line bg-ink p-3 text-sm text-neutral-300
                     focus:border-neutral-500 focus:outline-none"
        />

        <button
          disabled={saving || !weightInput}
          onClick={save}
          className="w-full rounded-2xl bg-neutral-100 py-4 text-lg font-semibold
                     text-ink disabled:opacity-40"
        >
          {savedFlash ? "Saved ✓" : saving ? "Saving…" : "Save"}
        </button>

        {error && (
          <p className="rounded-xl bg-red-950/60 p-3 text-sm text-red-300" role="alert">
            {error}
          </p>
        )}
      </section>

      {/* Retrieval: grouped by day, newest first, nothing to compute or interpret. */}
      <section className="space-y-4">
        {grouped.length === 0 ? (
          <p className="py-10 text-center text-sm text-neutral-600">
            No weights logged yet.
          </p>
        ) : (
          grouped.map(([day, entries]) => (
            <div key={day}>
              <h2 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">
                {new Date(`${day}T00:00:00`).toLocaleDateString([], {
                  weekday: "short", month: "short", day: "numeric",
                })}
              </h2>
              <ul className="divide-y divide-ink-line rounded-2xl bg-ink-soft">
                {entries.map((r) => (
                  <li key={r.id} className="flex items-center justify-between px-4 py-2">
                    <span className="text-sm text-neutral-400">{TIME_LABEL[r.time_of_day]}</span>
                    <div className="flex items-center gap-1">
                      <span className="tabular-nums">{kgToLb(r.weight_kg).toFixed(1)} lb</span>
                      <button
                        onClick={() => stage(r)}
                        className="flex min-h-11 min-w-11 items-center justify-center text-neutral-500"
                        aria-label="Delete entry"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <UndoBanner visible={!!pendingDelete} label="Weight entry deleted" onUndo={undo} />
    </div>
  );
}
