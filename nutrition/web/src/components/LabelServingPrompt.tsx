"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import { suggestLabelServing } from "@/lib/labelServing";
import type { Entry, LabelResult } from "@/lib/types";

/**
 * Turns a label scan into a real log. Label mode deliberately leaves calories null
 * (api/estimate/route.ts) - it records the product, not a meal - so this is what
 * actually answers "how much did you have," using the label's own numbers to guess
 * well rather than defaulting to a bare gram field (see lib/labelServing.ts for the
 * defaulting rules and why).
 *
 * Reads straight from `entry.ai_raw`, the retained raw scan result - no extra query.
 */
export default function LabelServingPrompt({
  entry,
  onLogged,
}: {
  entry: Entry;
  onLogged: () => void;
}) {
  const label = entry.ai_raw as LabelResult | null;
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!label?.per_100g) {
    return (
      <p className="text-xs text-neutral-500">
        No label data retained for this scan — delete and rescan to log a portion.
      </p>
    );
  }

  const suggestion = suggestLabelServing(label);
  const per100g = label.per_100g; // narrowed by the guard above; captured here so the
  // closure below doesn't need its own (TS can't carry the narrowing across it).

  async function logGrams(grams: number) {
    if (!Number.isFinite(grams) || grams <= 0) return;
    setBusy(true);
    setError(null);
    const scale = grams / 100;
    const { error: updErr } = await browserClient()
      .from("entries")
      .update({
        calories: Math.round(per100g.calories * scale),
        protein_g: Math.round(per100g.protein_g * scale),
        carbs_g: Math.round(per100g.carbs_g * scale),
        fat_g: Math.round(per100g.fat_g * scale),
        fiber_g: Math.round(per100g.fiber_g * scale),
        portion_multiplier: 1,
      })
      .eq("id", entry.id);
    setBusy(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    onLogged();
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-neutral-400">How much did you have?</div>

      <div className="flex flex-wrap gap-2">
        {suggestion.isWholeContainer ? (
          <button
            disabled={busy}
            onClick={() => logGrams(suggestion.defaultGrams)}
            className="min-h-11 flex-1 rounded-xl bg-neutral-100 px-3 text-sm font-semibold
                       text-ink disabled:opacity-40"
          >
            Whole container ({suggestion.defaultGrams}g)
          </button>
        ) : (
          <>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                disabled={busy}
                onClick={() => logGrams(suggestion.unitGrams * n)}
                className="min-h-11 flex-1 rounded-xl bg-ink-line text-sm text-neutral-200
                           disabled:opacity-40"
              >
                {n}× ({Math.round(suggestion.unitGrams * n)}g)
              </button>
            ))}
            {suggestion.containerGrams != null && (
              <button
                disabled={busy}
                onClick={() => logGrams(suggestion.containerGrams!)}
                className="min-h-11 w-full rounded-xl bg-ink-line text-sm text-neutral-300
                           disabled:opacity-40"
              >
                Whole container ({suggestion.containerGrams}g)
              </button>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Custom grams"
          className="flex-1 rounded-xl border border-ink-line bg-ink p-3 text-sm
                     placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <button
          disabled={busy || !custom}
          onClick={() => logGrams(parseFloat(custom))}
          className="min-h-11 rounded-xl bg-ink-line px-4 text-sm text-neutral-200 disabled:opacity-40"
        >
          Log
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
