"use client";

import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import { useDeferredDelete } from "@/lib/useDeferredDelete";
import { MULTIPLIERS, formatMultiplier } from "@/lib/portions";
import LabelServingPrompt from "./LabelServingPrompt";
import PortionChips from "./PortionChips";
import UndoBanner from "./UndoBanner";
import type { Entry } from "@/lib/types";

/** Past this long with no answer, treat a "pending" row as stuck rather than trust it
 *  will still resolve - comfortably past the server's maxDuration = 60 in
 *  api/estimate/route.ts, so a genuinely slow-but-alive call still has room to finish
 *  first. Without this, a dropped request or a cold-start timeout left an entry on
 *  "Analysing…" forever, since the retry affordance only ever showed for status
 *  'failed' and nothing ever flipped a stuck 'pending' row to that state. */
const STALL_MS = 90_000;

/**
 * Reverse-chronological list of the day's entries.
 *
 * Corrections are chips, not a form. No serving-size dropdowns and no gram entry:
 * grams-as-default is the single biggest friction sink in every mainstream tracker
 * (plan 4.2). An unconfirmed AI estimate counts as a complete log - it must never nag.
 */
export default function TodayList({ entries, onChange }: { entries: Entry[]; onChange: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Forces a re-check of which pending rows have gone stale - a stall is a function of
  // wall-clock time passing, not of any prop changing, so nothing else would re-render this.
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!entries.some((e) => e.status === "pending")) return;
    const id = setInterval(() => forceTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, [entries]);

  const { pending: pendingDelete, stage, undo } = useDeferredDelete<Entry>(async (entry) => {
    const { error: delErr } = await browserClient().from("entries").delete().eq("id", entry.id);
    if (delErr) setError(delErr.message);
    onChange();
  });

  async function setMultiplier(entry: Entry, m: number) {
    setError(null);
    const base = entry.portion_multiplier || 1;
    const k = m / base;
    const { error: updErr } = await browserClient()
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
    if (updErr) setError(updErr.message);
    setOpenId(null);
    onChange();
  }

  async function retry(entry: Entry) {
    setError(null);
    const { error: updErr } = await browserClient()
      .from("entries")
      .update({ status: "pending" })
      .eq("id", entry.id);
    if (updErr) {
      setError(updErr.message);
      return;
    }
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

  const visible = entries.filter((e) => e.id !== pendingDelete?.id);

  if (!visible.length) {
    return (
      <p className="py-10 text-center text-sm text-neutral-600">
        Nothing logged yet today.
      </p>
    );
  }

  return (
    <>
      <ul className="divide-y divide-ink-line">
        {visible.map((e) => {
          const pending = e.status === "pending";
          const stalled =
            pending && Date.now() - new Date(e.created_at).getTime() > STALL_MS;
          const failed = e.status === "failed" || stalled;
          // A label scan records the product but deliberately never assumes a portion
          // (plan/api/estimate route.ts) - this is the row's way of saying "still needs
          // an amount" rather than sitting on a permanent, uneditable "—".
          const unloggedLabel = e.mode === "label" && e.calories === null && !pending && !failed;
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
                    <span className={`truncate text-sm ${pending && !stalled ? "text-neutral-500" : ""}`}>
                      {stalled
                        ? "Taking longer than expected"
                        : pending
                          ? "Analysing…"
                          : failed
                            ? "Estimate failed"
                            : e.name}
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
                    {e.portion_multiplier !== 1 && ` · ${formatMultiplier(e.portion_multiplier)}`}
                    {e.meal_slot && ` · ${e.meal_slot.replace(/_/g, " ")}`}
                  </div>
                </div>

                <div className="text-right">
                  {pending && !stalled ? (
                    <span className="inline-block h-4 w-12 animate-pulse rounded bg-ink-line" />
                  ) : failed ? (
                    <span className="text-xs text-red-400">retry</span>
                  ) : unloggedLabel ? (
                    <span className="text-xs text-macro-kcal">log serving</span>
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
                      className="min-h-11 w-full rounded-xl bg-neutral-100 text-sm font-semibold text-ink"
                    >
                      Retry estimate
                    </button>
                  ) : unloggedLabel ? (
                    <LabelServingPrompt entry={e} onLogged={() => { setOpenId(null); onChange(); }} />
                  ) : (
                    <>
                      <div className="text-xs text-neutral-400">Portion</div>
                      <PortionChips
                        options={MULTIPLIERS.map((m) => ({ label: formatMultiplier(m), value: m }))}
                        selected={e.portion_multiplier}
                        onPick={(m) => setMultiplier(e, m)}
                        allowCustom
                        onCustom={(m) => setMultiplier(e, m)}
                      />
                      {e.calories_low != null && e.calories_high != null && (
                        <p className="text-xs text-neutral-500">
                          Estimated range {e.calories_low}–{e.calories_high} kcal
                        </p>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => {
                      setOpenId(null);
                      stage(e);
                    }}
                    className="min-h-11 w-full text-xs text-neutral-500"
                  >
                    Delete entry
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p className="mt-2 rounded-xl bg-red-950/60 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}

      <UndoBanner visible={!!pendingDelete} label="Entry deleted" onUndo={undo} />
    </>
  );
}

function scale(v: number | null, k: number): number | null {
  return v == null ? null : Math.round(v * k);
}
