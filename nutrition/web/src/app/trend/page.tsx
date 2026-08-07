"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { browserClient } from "@/lib/supabase/client";
import {
  GOAL_DATE, GOAL_WEIGHT_KG, PROTEIN_FLOOR_G, START_WEIGHT_KG,
  currentTrend, effectiveTdee, exceedsCeiling, isoDate, kgToLb, lbToKg,
  project, weeklyTrendChange, weightTrend, type Weighin,
} from "@/lib/nutrition";

export default function TrendPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [weighins, setWeighins] = useState<Weighin[]>([]);
  const [intakes, setIntakes] = useState<number[]>([]);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const db = browserClient();
    const { data: session } = await db.auth.getSession();
    const uid = session.session?.user.id ?? null;
    setUserId(uid);
    if (!uid) return;

    const [{ data: w }, { data: e }] = await Promise.all([
      db.from("weights").select("measured_on, weight_kg").eq("user_id", uid)
        .order("measured_on", { ascending: true }),
      db.from("entries").select("logged_at, calories").eq("user_id", uid)
        .gte("logged_at", new Date(Date.now() - 21 * 86_400_000).toISOString()),
    ]);

    setWeighins((w ?? []) as Weighin[]);

    // Daily totals, most recent 14 complete days. Days with no log are excluded rather
    // than counted as zero - a missing day is missing data, not a fast.
    const byDay = new Map<string, number>();
    for (const row of e ?? []) {
      const k = isoDate(new Date(row.logged_at as string));
      byDay.set(k, (byDay.get(k) ?? 0) + ((row.calories as number) ?? 0));
    }
    setIntakes([...byDay.entries()].sort().slice(-14).map(([, v]) => v));
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveWeight() {
    const lb = parseFloat(input);
    if (!userId || !Number.isFinite(lb)) return;
    setSaving(true);
    await browserClient().from("weights").upsert(
      { user_id: userId, measured_on: isoDate(new Date()), weight_kg: lbToKg(lb) },
      { onConflict: "user_id,measured_on" }
    );
    setInput("");
    setSaving(false);
    void load();
  }

  const trendKg = currentTrend(weighins);
  const weeklyKg = weeklyTrendChange(weighins);
  const tdee = weeklyKg !== null ? effectiveTdee(intakes, weeklyKg) : null;
  const projection = trendKg !== null && weeklyKg !== null ? project(trendKg, weeklyKg) : null;
  const points = weightTrend(weighins);

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 pb-safe">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Trend</h1>
        <Link href="/" className="rounded-full bg-ink-soft px-3 py-2 text-xs text-neutral-300">
          Back
        </Link>
      </header>

      {/* Weigh-in. The only manual data entry in the app. */}
      <section className="space-y-2">
        <div className="flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Weight in lb"
            className="flex-1 rounded-2xl border border-ink-line bg-ink-soft p-4
                       focus:border-neutral-500 focus:outline-none"
          />
          <button
            onClick={saveWeight}
            disabled={saving || !input}
            className="rounded-2xl bg-neutral-100 px-6 font-semibold text-ink disabled:opacity-40"
          >
            Save
          </button>
        </div>
        <p className="text-xs text-neutral-500">
          Weigh in daily when you can, but compare <strong>Friday to Friday</strong>. Sunday
          runs 1–3 lb high on Shabbat water and sodium.
        </p>
      </section>

      {/* Headline: projected finish date, not a progress bar. A percentage-complete bar
          looks healthiest exactly when the trend has gone flat. */}
      <section className="rounded-3xl bg-ink-soft p-4">
        {trendKg === null ? (
          <p className="text-sm text-neutral-500">
            Log a few weigh-ins and the trend appears here.
          </p>
        ) : (
          <>
            <div className="text-xs uppercase tracking-wide text-neutral-500">Trend weight</div>
            <div className="text-4xl font-semibold tabular-nums">
              {kgToLb(trendKg).toFixed(1)}
              <span className="ml-1 text-sm font-normal text-neutral-500">lb</span>
            </div>
            <div className="mt-1 text-sm text-neutral-400">
              {weeklyKg === null
                ? "Not enough data for a rate yet"
                : `${kgToLb(weeklyKg) >= 0 ? "+" : ""}${kgToLb(weeklyKg).toFixed(2)} lb/week`}
            </div>

            {projection && (
              <div className="mt-4 border-t border-ink-line pt-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-neutral-400">Projected finish</span>
                  <span className={projection.onTrack ? "text-macro-protein" : "text-macro-kcal"}>
                    {projection.finishDate
                      ? projection.finishDate.toLocaleDateString([], {
                          day: "numeric", month: "short", year: "numeric",
                        })
                      : "not losing"}
                  </span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-neutral-400">Projected on {GOAL_DATE}</span>
                  <span className="tabular-nums">
                    {kgToLb(projection.weightOnGoalDate).toFixed(1)} lb
                  </span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-neutral-400">Rate needed from here</span>
                  <span className="tabular-nums">
                    {kgToLb(projection.requiredRateKg).toFixed(2)} lb/wk
                  </span>
                </div>
              </div>
            )}

            {weeklyKg !== null && trendKg !== null && exceedsCeiling(weeklyKg, trendKg) && (
              <p className="mt-3 rounded-xl bg-amber-950/50 p-3 text-xs text-amber-200">
                Losing faster than 1%/week. If this holds for another week, raise the calorie
                target — at this rate the loss starts costing lean mass.
              </p>
            )}
          </>
        )}
      </section>

      {/* Adaptive TDEE (plan 3.1) */}
      <section className="rounded-3xl bg-ink-soft p-4">
        <div className="text-xs uppercase tracking-wide text-neutral-500">Measured expenditure</div>
        {!tdee ? (
          <p className="mt-2 text-sm text-neutral-500">
            Needs 10 days of logs and weigh-ins. {intakes.length}/10 days so far.
          </p>
        ) : (
          <>
            <div className="text-3xl font-semibold tabular-nums">
              {Math.round(tdee.effectiveTdee)}
              <span className="ml-1 text-sm font-normal text-neutral-500">kcal/day</span>
            </div>
            <div className="mt-2 space-y-1 text-xs text-neutral-500">
              <div>Mean intake {Math.round(tdee.meanIntake)} + deficit {Math.round(tdee.impliedDeficit)}</div>
              <div>{tdee.daysLogged} days logged</div>
              {!tdee.trustworthy && (
                <div className="text-amber-300">
                  Shown but not yet driving your target — needs 14 days.
                </div>
              )}
            </div>
            <p className="mt-3 text-xs text-neutral-600">
              This is expenditure in the app&apos;s own units, not a lab measurement. A
              consistent estimation bias is absorbed here and cancels out of your target.
            </p>
          </>
        )}
      </section>

      {/* Sparkline: trend line with raw weigh-ins behind it. */}
      {points.length > 1 && <Sparkline points={points} />}

      <p className="text-center text-xs text-neutral-600">
        Start {kgToLb(START_WEIGHT_KG).toFixed(0)} lb · Goal{" "}
        {kgToLb(GOAL_WEIGHT_KG).toFixed(0)} lb · Protein floor {PROTEIN_FLOOR_G} g/day
      </p>
    </div>
  );
}

function Sparkline({ points }: { points: { date: string; weight_kg: number; trend_kg: number }[] }) {
  const W = 320;
  const H = 90;
  const weights = points.flatMap((p) => [p.weight_kg, p.trend_kg]);
  const min = Math.min(...weights) - 0.3;
  const max = Math.max(...weights) + 0.3;
  const x = (i: number) => (i / Math.max(1, points.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / (max - min)) * H;

  const trendPath = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.trend_kg)}`).join(" ");

  return (
    <section className="rounded-3xl bg-ink-soft p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
        Trend vs. raw weigh-ins
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Weight trend">
        {points.map((p, i) => (
          <circle key={p.date} cx={x(i)} cy={y(p.weight_kg)} r="2" fill="#3f3f46" />
        ))}
        <path d={trendPath} fill="none" stroke="#2a9d8f" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </section>
  );
}
