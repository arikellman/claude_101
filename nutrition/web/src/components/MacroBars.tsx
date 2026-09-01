"use client";

import { PROTEIN_FLOOR_G } from "@/lib/nutrition";

interface Props {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Today's calorie allocation (1800 / 2150 / 2500 depending on the day). */
  budget: number;
}

function Bar({
  label, value, max, unit, color, floor,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  color: string;
  /** Draw a target marker, e.g. the protein floor. */
  floor?: number;
}) {
  const pct = Math.min(100, (value / max) * 100);
  const over = value > max;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-neutral-400">{label}</span>
        <span className={over ? "font-semibold text-macro-fat" : "font-semibold"}>
          {Math.round(value)}
          <span className="text-neutral-500">
            /{Math.round(max)} {unit}
          </span>
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-ink-line">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: over ? "#e76f51" : color }}
        />
        {floor !== undefined && floor < max && (
          // Marker for the protein floor: a target to reach, not a cap to stay under.
          <div
            className="absolute top-0 h-full w-0.5 bg-neutral-300/70"
            style={{ left: `${(floor / max) * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The four numbers that matter. Protein gets equal prominence to calories deliberately:
 * at a ~690 kcal/day deficit it is the variable that decides whether the loss is fat or
 * fat plus muscle (plan 3.3).
 */
export default function MacroBars({ calories, protein, carbs, fat, budget }: Props) {
  return (
    <div className="space-y-3">
      <Bar label="Calories" value={calories} max={budget} unit="kcal" color="#f4a261" />
      <Bar
        label="Protein"
        value={protein}
        max={Math.max(PROTEIN_FLOOR_G * 1.3, protein)}
        unit="g"
        color="#2a9d8f"
        floor={PROTEIN_FLOOR_G}
      />
      <div className="grid grid-cols-2 gap-3">
        <Bar label="Carbs" value={carbs} max={Math.max(250, carbs)} unit="g" color="#8ab4f8" />
        <Bar label="Fat" value={fat} max={Math.max(80, fat)} unit="g" color="#e76f51" />
      </div>
    </div>
  );
}
