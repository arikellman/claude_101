"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Capture from "@/components/Capture";
import MacroBars from "@/components/MacroBars";
import NavPill from "@/components/NavPill";
import SignIn from "@/components/SignIn";
import TodayList from "@/components/TodayList";
import { browserClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/useSession";
import { dailyBudget, isoDate, weeklyRemaining } from "@/lib/nutrition";
import type { Entry } from "@/lib/types";

export default function Home() {
  const { userId, loading } = useSession();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [weekIntake, setWeekIntake] = useState<Map<string, number>>(new Map());

  // browserClient() is a lazy singleton - called inside effects/handlers only, never
  // during render, so the server prerender pass never touches it.
  const today = useMemo(() => new Date(), []);
  const budget = dailyBudget(today);

  // ---------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------
  const load = useCallback(async () => {
    if (!userId) return;
    const db = browserClient();
    const dayStart = `${isoDate(today)}T00:00:00`;

    const [{ data: todays }, { data: week }] = await Promise.all([
      db
        .from("entries")
        .select("*")
        .eq("user_id", userId)
        .gte("logged_at", dayStart)
        .order("logged_at", { ascending: false }),
      // Trailing 10 days covers the current Friday-to-Friday week from any starting day.
      db
        .from("entries")
        .select("logged_at, calories, shabbat_plan_id, reconciled_at")
        .eq("user_id", userId)
        .gte("logged_at", new Date(Date.now() - 10 * 86_400_000).toISOString()),
    ]);

    // A Friday-afternoon pre-log lands with logged_at inside the Shabbat window (plan
    // 10.2), which can be "today" the moment it's saved. It must not count toward the
    // budget until reconciled - counting a plan as if it were eaten defeats the entire
    // point of pre-logging, which is to record intent, not consumption.
    const notYetReconciled = (e: { shabbat_plan_id: string | null; reconciled_at: string | null }) =>
      e.shabbat_plan_id !== null && e.reconciled_at === null;

    setEntries((todays ?? []).filter((e) => !notYetReconciled(e as Entry)) as Entry[]);

    const byDay = new Map<string, number>();
    for (const row of week ?? []) {
      if (notYetReconciled(row as { shabbat_plan_id: string | null; reconciled_at: string | null }))
        continue;
      const key = isoDate(new Date(row.logged_at as string));
      byDay.set(key, (byDay.get(key) ?? 0) + ((row.calories as number) ?? 0));
    }
    setWeekIntake(byDay);
  }, [userId, today]);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: an estimate landing while the phone was locked must appear without a
  // refresh. This is what lets you snap and walk away (plan 4.1).
  useEffect(() => {
    if (!userId) return;
    const db = browserClient();
    const channel = db
      .channel("entries-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "entries", filter: `user_id=eq.${userId}` },
        () => void load()
      )
      .subscribe();
    return () => void db.removeChannel(channel);
  }, [userId, load]);

  // ---------------------------------------------------------------------
  // Totals
  // ---------------------------------------------------------------------
  const totals = useMemo(() => {
    return entries.reduce(
      (a, e) => ({
        calories: a.calories + (e.calories ?? 0),
        protein: a.protein + (e.protein_g ?? 0),
        carbs: a.carbs + (e.carbs_g ?? 0),
        fat: a.fat + (e.fat_g ?? 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 }
    );
  }, [entries]);

  const week = useMemo(() => weeklyRemaining(today, weekIntake), [today, weekIntake]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  if (loading) {
    return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  }
  if (!userId) return <SignIn />;

  return (
    <div className="flex flex-1 flex-col gap-5 p-4 pb-safe">
      <header className="flex items-baseline justify-between">
        <div>
          <div className="text-3xl font-semibold tabular-nums">
            {Math.max(0, budget - totals.calories)}
            <span className="ml-1 text-sm font-normal text-neutral-500">kcal left today</span>
          </div>
          <div className="text-xs text-neutral-500">
            {week.remaining >= 0
              ? `${week.remaining} left this week`
              : `${-week.remaining} over this week`}
            {" · "}
            {today.toLocaleDateString([], { weekday: "long" })} budget {budget}
          </div>
        </div>
        <div className="flex gap-2">
          <NavPill href="/settings" label="⚙" />
          <NavPill href="/weight" label="⚖" />
          <NavPill href="/trend" label="Trend" />
        </div>
      </header>

      <nav className="flex gap-2 text-xs">
        <NavPill href="/again" label="Again" className="flex-1" />
        <NavPill href="/shabbat/prep" label="Shabbat Prep" className="flex-1" />
        <NavPill href="/shabbat/reconcile" label="Wrap-up" className="flex-1" />
      </nav>

      <Capture userId={userId} onLogged={load} />

      <MacroBars
        calories={totals.calories}
        protein={totals.protein}
        carbs={totals.carbs}
        fat={totals.fat}
        budget={budget}
      />

      <section>
        <h2 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">Today</h2>
        <TodayList entries={entries} onChange={load} />
      </section>
    </div>
  );
}
