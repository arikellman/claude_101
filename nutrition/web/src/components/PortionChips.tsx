"use client";

import { useState } from "react";

/**
 * The one portion-chip row component. TodayList, Again's portion picker, and Shabbat
 * reconciliation each rendered their own version of this with different padding, font
 * size, and label formatting - same action, three different tap targets. Reconcile
 * keeps its own option set (it needs "skipped" and 3x, which nowhere else does) but
 * now renders through the same component so the chip itself looks and behaves the same.
 *
 * `allowCustom` adds a typed-number fallback - the fixed chip set (½/1/1½/2×) covers the
 * common case, but "I had three times the usual portion" has no chip for it and
 * shouldn't need one; a number field is the honest answer for the long tail.
 */
export interface ChipOption<T> {
  label: string;
  value: T;
}

export default function PortionChips<T>({
  options,
  selected,
  onPick,
  disabled,
  allowCustom,
  onCustom,
}: {
  options: ChipOption<T>[];
  /** Highlights the active chip. Omit where nothing is "currently selected" (Again,
   *  Reconcile - each tap resolves immediately rather than tracking a current state). */
  selected?: T;
  onPick: (value: T) => void;
  disabled?: boolean;
  allowCustom?: boolean;
  /** Called with the parsed number when a custom amount is submitted. Separate from
   *  onPick because T isn't guaranteed to be `number` for every caller (Reconcile's
   *  option set includes "skipped") - a custom entry is always a plain multiplier. */
  onCustom?: (value: number) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");

  function submitCustom() {
    const n = parseFloat(customValue);
    if (!Number.isFinite(n) || n <= 0) return;
    onCustom?.(n);
    setCustomValue("");
    setCustomOpen(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {options.map((opt, i) => (
          <button
            key={i}
            disabled={disabled}
            onClick={() => onPick(opt.value)}
            className={`min-h-11 flex-1 rounded-xl text-sm disabled:opacity-40 ${
              selected === opt.value
                ? "bg-neutral-100 font-semibold text-ink"
                : "bg-ink-line text-neutral-300"
            }`}
          >
            {opt.label}
          </button>
        ))}
        {allowCustom && (
          <button
            disabled={disabled}
            onClick={() => setCustomOpen((o) => !o)}
            className={`min-h-11 flex-1 rounded-xl text-sm disabled:opacity-40 ${
              customOpen ? "bg-neutral-100 font-semibold text-ink" : "bg-ink-line text-neutral-300"
            }`}
          >
            Custom
          </button>
        )}
      </div>

      {customOpen && (
        <div className="flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            autoFocus
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCustom();
            }}
            placeholder="e.g. 3"
            className="flex-1 rounded-xl border border-ink-line bg-ink p-3 text-sm
                       placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          <button
            disabled={!customValue}
            onClick={submitCustom}
            className="min-h-11 rounded-xl bg-neutral-100 px-4 text-sm font-semibold text-ink
                       disabled:opacity-40"
          >
            Set
          </button>
        </div>
      )}
    </div>
  );
}
