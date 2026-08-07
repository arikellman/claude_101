"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import type { Entry } from "@/lib/types";

const MULTIPLIERS = [0.5, 1, 1.5, 2];

/**
 * Reverse-chronological list of the day's entries.
 *
 * Corrections are chips, not a form. No serving-size dropdowns and no gram entry:
 * grams-as-default is the single biggest friction sink in every mainstream tracker
 * (plan 4.2). An unconfirmed AI estimate counts as a complete log - it must never nag.
 */
export default function TodayList({ entries, onChange }: { entries: Entry[]; onChange: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);

  async function setMultiplier(entry: Entry, m: number) {
    const db = browserClient();
    const base = entry.portion_multiplier || 1;
    const k = m / base;
    await db
      .from("entries")
      .update({
        portion_multiplier: m,
        user_corrected: true,
        status: "confirmed",
        calories: scale(entry.calories, k),
        protein_g: scale(entry.protein_g, k),
        carbs_g: scale(entry.carbs_g, k),
        fat_g: scale(entry.fat_g, k),
        fiber_g: scale(entry.fiber_g, k),
      })
      .eq("id", entry.id);
    setOpenId(null);
    onChange();
  }

  async function remove(id: string) {
    await browserClient().from("entries").delete().eq("id", id);
    onChange();
  }

  async function retry(entry: Entry) {
    await browserClient().from("entries").update({ status: "pending" }).eq("id", entry.id);
    onChange();
    fetch("/api/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryId: entry.id,
        userId: entry.user_id,
        mode: entry.mode,
        photoPath: entry.photo_path,
        text: entry.raw_input,
      }),
    }).catch(() => {});
  }

  if (!entries.length) {
    return (
      <p className="py-10 text-center text-sm text-neutral-600">
        Nothing logged yet today.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-ink-line">
      {entries.map((e) => {
        const pending = e.status === "pending";
        const failed = e.status === "failed";
        const wide =
          e.calories && e.calories_high && e.calories_low
            ? (e.calories_high - e.calories_low) / e.calories > 0.5
            : false;

        return (
          <li key={e.id} className="py-3">
            <button
              onClick={() => setOpenId(openId === e.id ? null : e.id)}
              className="flex w-full items-center gap-3 text-left"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`truncate text-sm ${pending ? "text-neutral-500" : ""}`}>
                    {pending ? "Analysing…" : failed ? "Estimate failed" : e.name}
                  </span>
                  {/* Amber dot: the model flagged low confidence or returned a wide range.
                      Only shown if confidence turns out to predict error - see score.py's
                      calibration check. */}
                  {(e.confidence === "low" || wide) && !pending && (
                    <span className="text-macro-kcal" title="Low confidence — tap to review">
                      ●
                    </span>
                  )}
                  {e.low_confidence && (
                    <span className="text-xs text-neutral-600" title="Reconciled late">
                      late
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {new Date(e.logged_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {e.portion_multiplier !== 1 && ` · ${e.portion_multiplier}×`}
                  {e.meal_slot && ` · ${e.meal_slot.replace(/_/g, " ")}`}
                </div>
              </div>

              <div className="text-right">
                {pending ? (
                  <span className="inline-block h-4 w-12 animate-pulse rounded bg-ink-line" />
                ) : failed ? (
                  <span className="text-xs text-red-400">retry</span>
                ) : (
                  <>
                    <div className="font-semibold">{e.calories ?? "—"}</div>
                    <div className="text-xs text-macro-protein">{e.protein_g ?? 0}g P</div>
                  </>
                )}
              </div>
            </button>

            {openId === e.id && (
              <div className="mt-3 space-y-3 rounded-2xl bg-ink-soft p-3">
                {failed ? (
                  <button
                    onClick={() => retry(e)}
                    className="w-full rounded-xl bg-neutral-100 py-3 text-sm font-semibold text-ink"
                  >
                    Retry estimate
                  </button>
                ) : (
                  <>
                    <div className="text-xs text-neutral-400">Portion</div>
                    <div className="flex gap-2">
                      {MULTIPLIERS.map((m) => (
                        <button
                          key={m}
                          onClick={() => setMultiplier(e, m)}
                          className={`flex-1 rounded-xl py-3 text-sm ${
                            e.portion_multiplier === m
                              ? "bg-neutral-100 font-semibold text-ink"
                              : "bg-ink-line text-neutral-300"
                          }`}
                        >
                          {m === 0.5 ? "½×" : m === 1.5 ? "1½×" : `${m}×`}
                        </button>
                      ))}
                    </div>
                    {e.calories_low != null && e.calories_high != null && (
                      <p className="text-xs text-neutral-500">
                        Estimated range {e.calories_low}–{e.calories_high} kcal
                      </p>
                    )}
                  </>
                )}
                <button
                  onClick={() => remove(e.id)}
                  className="w-full py-2 text-xs text-neutral-500"
                >
                  Delete entry
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function scale(v: number | null, k: number): number | null {
  return v == null ? null : Math.round(v * k);
}
