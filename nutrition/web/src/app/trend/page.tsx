"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/useSession";
import NavPill from "@/components/NavPill";
import SignIn from "@/components/SignIn";
import {
  GOAL_DATE, GOAL_WEIGHT_KG, PROTEIN_FLOOR_G, START_WEIGHT_KG,
  currentTrend, effectiveTdee, exceedsCeiling, isoDate,
  kgToLb, project, weeklyTrendChange, weightTrend, type Weighin,
} from "@/lib/nutrition";

interface WeightLogRow {
  measured_on: string;
  time_of_day: "morning" | "afternoon" | "evening";
  weight_kg: number;
  created_at: string;
}

interface WearableRow {
  date: string;
  steps: number | null;
  sleep_minutes: number | null;
  resting_hr: number | null;
}

/**
 * One weigh-in per day, for the trend math below (which expects at most one weight per
 * date). Prefers the morning entry - the plan's TDEE design assumes a pre-day reading
 * (§3.2) - and otherwise falls back to whichever was logged earliest that day. This is
 * a display-layer data shape, not the app's nutrition math itself: lib/nutrition.ts's
 * functions are untouched, this only changes what feeds them.
 */
function collapseToOnePerDay(rows: WeightLogRow[]): Weighin[] {
  const byDay = new Map<string, WeightLogRow[]>();
  for (const r of rows) byDay.set(r.measured_on, [...(byDay.get(r.measured_on) ?? []), r]);

  const out: Weighin[] = [];
  for (const [day, entries] of byDay) {
    const morning = entries.find((r) => r.time_of_day === "morning");
    const chosen = morning ?? [...entries].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    out.push({ measured_on: day, weight_kg: chosen.weight_kg });
  }
  return out;
}

export default function TrendPage() {
  const { userId, loading } = useSession();
  const [weighins, setWeighins] = useState<Weighin[]>([]);
  const [intakes, setIntakes] = useState<number[]>([]);
  const [wearable, setWearable] = useState<WearableRow[]>([]);

  const load = useCallback(async () => {
    if (!userId) return;

    const db = browserClient();
    const [{ data: w }, { data: e }, { data: wear }] = await Promise.all([
      // The weight diary at /weight is now the only place weight gets logged (plan
      // review, 2026-08-09) - this used to read a separate `weights` table fed by an
      // inline field on this page, so logging faithfully through /weight never moved
      // this number at all. One input, one table, everywhere.
      db.from("weight_log").select("measured_on, time_of_day, weight_kg, created_at")
        .eq("user_id", userId).order("measured_on", { ascending: true }),
      db.from("entries").select("logged_at, calories").eq("user_id", userId)
        .gte("logged_at", new Date(Date.now() - 21 * 86_400_000).toISOString()),
      db.from("wearable_daily").select("date, steps, sleep_minutes, resting_hr")
        .eq("user_id", userId).order("date", { ascending: false }).limit(60),
    ]);

    setWeighins(collapseToOnePerDay((w ?? []) as WeightLogRow[]));
    setWearable((wear ?? []) as WearableRow[]);

    // Daily totals, most recent 14 complete days. Days with no log are excluded rather
    // than counted as zero - a missing day is missing data, not a fast.
    const byDay = new Map<string, number>();
    for (const row of e ?? []) {
      const k = isoDate(new Date(row.logged_at as string));
      byDay.set(k, (byDay.get(k) ?? 0) + ((row.calories as number) ?? 0));
    }
    setIntakes([...byDay.entries()].sort().slice(-14).map(([, v]) => v));
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  const trendKg = currentTrend(weighins);
  const weeklyKg = weeklyTrendChange(weighins);
  const tdee = weeklyKg !== null ? effectiveTdee(intakes, weeklyKg) : null;
  const projection = trendKg !== null && weeklyKg !== null ? project(trendKg, weeklyKg) : null;
  const points = weightTrend(weighins);

  if (loading) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!userId) return <SignIn />;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 pb-safe">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Trend</h1>
        <NavPill href="/" />
      </header>

      {/* Headline: projected finish date, not a progress bar. A percentage-complete bar
          looks healthiest exactly when the trend has gone flat. */}
      <section className="rounded-3xl bg-ink-soft p-4">
        {trendKg === null ? (
          <p className="text-sm text-neutral-500">
            No weigh-ins yet.{" "}
            <NavPill href="/weight" label="Log one" className="mt-2 inline-flex" />
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

      {/* Wearable (Zepp/Helios) - informational only. Deliberately not fed into
          effectiveTdee() above; see the comment on wearable_daily in schema.sql. */}
      {wearable.length > 0 && <WearableTrends rows={wearable} />}

      <p className="text-center text-xs text-neutral-600">
        Start {kgToLb(START_WEIGHT_KG).toFixed(0)} lb · Goal{" "}
        {kgToLb(GOAL_WEIGHT_KG).toFixed(0)} lb · Protein floor {PROTEIN_FLOOR_G} g/day
      </p>
    </div>
  );
}

/**
 * Wearable (Zepp/Helios) history - three small charts sharing one x-axis, plus today's
 * headline numbers. Resting HR skips days with no reading (null) rather than plotting
 * a false zero or a misleading straight line through a gap - same reasoning as
 * weightTrend()'s handling of missing weigh-ins.
 */
function WearableTrends({ rows }: { rows: WearableRow[] }) {
  const ordered = [...rows].reverse(); // rows arrive newest-first from the query
  const latest = ordered[ordered.length - 1];
  const daysWithHr = ordered.filter((r) => r.resting_hr != null).length;

  return (
    <section className="rounded-3xl bg-ink-soft p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wide text-neutral-500">
          Wearable (last {ordered.length} days)
        </div>
        <div className="text-xs text-neutral-500">
          {new Date(`${latest.date}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short" })}:{" "}
          {latest.steps == null ? "—" : `${latest.steps.toLocaleString()} steps`}
          {latest.resting_hr != null && ` · ${latest.resting_hr} bpm`}
        </div>
      </div>

      <BarChart
        label="Steps"
        values={ordered.map((r) => r.steps ?? 0)}
        formatMax={(v) => v.toLocaleString()}
      />
      <BarChart
        label="Sleep"
        values={ordered.map((r) => (r.sleep_minutes ?? 0) / 60)}
        formatMax={(v) => `${v.toFixed(1)}h`}
      />
      {daysWithHr > 1 && (
        <LineChart
          label="Resting HR"
          points={ordered
            .map((r, i) => ({ i, v: r.resting_hr }))
            .filter((p): p is { i: number; v: number } => p.v != null)}
          count={ordered.length}
          formatValue={(v) => `${Math.round(v)} bpm`}
        />
      )}

      <p className="mt-1 text-xs text-neutral-600">
        Context only - not part of the calorie target above. A day showing 0 usually
        means the strap wasn&apos;t worn/synced (e.g. Shabbat), not real inactivity.
      </p>
    </section>
  );
}

function BarChart({
  label,
  values,
  formatMax,
}: {
  label: string;
  values: number[];
  formatMax: (v: number) => string;
}) {
  const W = 320;
  const H = 44;
  const max = Math.max(...values, 1);
  const barW = W / values.length;

  return (
    <div className="mt-2 first:mt-0">
      <div className="mb-1 flex justify-between text-xs text-neutral-500">
        <span>{label}</span>
        <span className="tabular-nums">max {formatMax(max)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${label} by day`}>
        {values.map((v, i) => {
          const h = (v / max) * H;
          return (
            <rect
              key={i}
              x={i * barW + 0.5}
              y={H - h}
              width={Math.max(1, barW - 1)}
              height={h}
              fill="#3f3f46"
            />
          );
        })}
      </svg>
    </div>
  );
}

function LineChart({
  label,
  points,
  count,
  formatValue,
}: {
  label: string;
  points: { i: number; v: number }[];
  count: number;
  formatValue: (v: number) => string;
}) {
  const W = 320;
  const H = 44;
  const values = points.map((p) => p.v);
  const min = Math.min(...values) - 2;
  const max = Math.max(...values) + 2;
  const x = (i: number) => (i / Math.max(1, count - 1)) * W;
  const y = (v: number) => H - ((v - min) / (max - min)) * H;
  const path = points.map((p, idx) => `${idx ? "L" : "M"}${x(p.i)},${y(p.v)}`).join(" ");
  const last = points[points.length - 1];

  return (
    <div className="mt-2">
      <div className="mb-1 flex justify-between text-xs text-neutral-500">
        <span>{label}</span>
        <span className="tabular-nums">latest {formatValue(last.v)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${label} by day`}>
        <path d={path} fill="none" stroke="#2a9d8f" strokeWidth="1.5" strokeLinecap="round" />
        {points.map((p) => (
          <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r="1.5" fill="#2a9d8f" />
        ))}
      </svg>
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
