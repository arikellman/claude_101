"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Capture from "@/components/Capture";
import MacroBars from "@/components/MacroBars";
import TodayList from "@/components/TodayList";
import { browserClient } from "@/lib/supabase/client";
import { dailyBudget, isoDate, weeklyRemaining } from "@/lib/nutrition";
import type { Entry } from "@/lib/types";

export default function Home() {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [weekIntake, setWeekIntake] = useState<Map<string, number>>(new Map());

  // browserClient() is a lazy singleton - called inside effects/handlers only, never
  // during render, so the server prerender pass never touches it.
  const today = useMemo(() => new Date(), []);
  const budget = dailyBudget(today);

  // ---------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------
  useEffect(() => {
    const db = browserClient();
    db.auth.getSession().then(({ data }) => {
      setUserId(data.session?.user.id ?? null);
      setLoading(false);
    });
    const { data: sub } = db.auth.onAuthStateChange((_e, session) => {
      setUserId(session?.user.id ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

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
        .select("logged_at, calories")
        .eq("user_id", userId)
        .gte("logged_at", new Date(Date.now() - 10 * 86_400_000).toISOString()),
    ]);

    setEntries((todays ?? []) as Entry[]);

    const byDay = new Map<string, number>();
    for (const row of week ?? []) {
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
        <Link href="/trend" className="rounded-full bg-ink-soft px-3 py-2 text-xs text-neutral-300">
          Trend
        </Link>
      </header>

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

/** Magic-link sign-in. Single user, so there is no sign-up flow to build. */
function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    const { error } = await browserClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="flex flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Nutrition Log</h1>
      {sent ? (
        <p className="text-sm text-neutral-400">
          Check {email} for a sign-in link.
        </p>
      ) : (
        <>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="rounded-2xl border border-ink-line bg-ink-soft p-4
                       focus:border-neutral-500 focus:outline-none"
          />
          <button
            onClick={send}
            disabled={!email.includes("@")}
            className="rounded-2xl bg-neutral-100 py-4 font-semibold text-ink disabled:opacity-40"
          >
            Send sign-in link
          </button>
        </>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
