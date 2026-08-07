/**
 * Tests for the nutrition math. Run with:  npm test
 *
 * These assert the numbers from nutrition-app-plan.md sections 3.1-3.3, so if someone
 * later "tidies" a constant, the plan and the code diverge loudly rather than silently.
 *
 * Uses node:test against the compiled-away types via a tiny TS-free re-export shim, so
 * it runs with no build step. Keep assertions on behaviour, not implementation.
 */

import test from "node:test";
import assert from "node:assert/strict";

// Import the TypeScript source directly - Node 22+ strips types natively.
const {
  DAILY_BUDGET,
  WEEKLY_BUDGET,
  PROTEIN_FLOOR_G,
  KCAL_PER_KG,
  dailyBudget,
  weekBoundary,
  weeklyRemaining,
  weightTrend,
  weeklyTrendChange,
  effectiveTdee,
  nextWeekTarget,
  exceedsCeiling,
  project,
  isoDate,
  daysBetween,
  kgToLb,
} = await import("./nutrition.ts");

// ---------------------------------------------------------------------------
// Budget (plan 3.3)
// ---------------------------------------------------------------------------

test("weekly budget totals 13,650 kcal", () => {
  assert.equal(WEEKLY_BUDGET, 13650);
});

test("budget is uneven: 1800 Sun-Thu, 2150 Fri, 2500 Sat", () => {
  for (const d of [0, 1, 2, 3, 4]) assert.equal(DAILY_BUDGET[d], 1800);
  assert.equal(DAILY_BUDGET[5], 2150);
  assert.equal(DAILY_BUDGET[6], 2500);
});

test("the uneven split is exactly a transfer: 750 saved Sun-Thu, 750 to Shabbat", () => {
  // Plan 3.3. A flat 1950/day is the same weekly total, so the split must balance.
  const flat = 1950;
  assert.equal(flat * 7, WEEKLY_BUDGET);

  const savedSunThu = [0, 1, 2, 3, 4].reduce((a, d) => a + (flat - DAILY_BUDGET[d]), 0);
  const shabbatExtra = DAILY_BUDGET[5] + DAILY_BUDGET[6] - flat * 2;

  assert.equal(savedSunThu, 750);
  assert.equal(shabbatExtra, 750);
  assert.equal(savedSunThu, shabbatExtra, "the split must be a pure transfer");
});

test("dailyBudget reads the day of week", () => {
  assert.equal(dailyBudget(new Date("2026-08-08T12:00:00")), 2500); // Saturday
  assert.equal(dailyBudget(new Date("2026-08-07T12:00:00")), 2150); // Friday
  assert.equal(dailyBudget(new Date("2026-08-10T12:00:00")), 1800); // Monday
});

test("protein floor is 2.0 g/kg of target weight", () => {
  assert.equal(PROTEIN_FLOOR_G, 150);
  assert.ok(Math.abs(PROTEIN_FLOOR_G / 74.8 - 2.0) < 0.01);
});

// ---------------------------------------------------------------------------
// Friday-to-Friday week boundary (plan 3.2)
// ---------------------------------------------------------------------------

test("week always ends on a Friday", () => {
  for (const iso of ["2026-08-06", "2026-08-07", "2026-08-08", "2026-08-11"]) {
    const { end } = weekBoundary(new Date(`${iso}T12:00:00`));
    assert.equal(end.getDay(), 5, `${iso} -> end ${isoDate(end)} is not a Friday`);
  }
});

test("a Friday is its own week end, not pushed a week out", () => {
  const { end } = weekBoundary(new Date("2026-08-07T12:00:00")); // a Friday
  assert.equal(isoDate(end), "2026-08-07");
});

test("week spans exactly 7 days", () => {
  const { start, end } = weekBoundary(new Date("2026-08-10T12:00:00"));
  assert.equal(daysBetween(isoDate(start), isoDate(end)), 6);
});

test("weeklyRemaining sums only elapsed days", () => {
  // Saturday 2026-08-08. Week runs Sat 08-08 .. Fri 08-14, so 1 day elapsed.
  const intake = new Map([["2026-08-08", 2000]]);
  const r = weeklyRemaining(new Date("2026-08-08T20:00:00"), intake);
  assert.equal(r.daysElapsed, 1);
  assert.equal(r.budget, 2500); // Saturday only
  assert.equal(r.consumed, 2000);
  assert.equal(r.remaining, 500);
});

// ---------------------------------------------------------------------------
// EWMA trend (plan 3.2)
// ---------------------------------------------------------------------------

test("trend smooths noise and lags raw weight", () => {
  const pts = weightTrend([
    { measured_on: "2026-08-01", weight_kg: 88.0 },
    { measured_on: "2026-08-02", weight_kg: 89.5 }, // water spike
    { measured_on: "2026-08-03", weight_kg: 88.1 },
  ]);
  assert.equal(pts[0].trend_kg, 88.0); // seeds on first observation
  assert.ok(pts[1].trend_kg < 89.5, "trend must not chase the spike");
  assert.ok(pts[1].trend_kg > 88.0);
});

test("trend tolerates Shabbat gaps without distortion", () => {
  // No Saturday weigh-in - a missing observation, not a zero.
  const withGap = weightTrend([
    { measured_on: "2026-08-06", weight_kg: 88.0 },
    { measured_on: "2026-08-07", weight_kg: 87.8 },
    { measured_on: "2026-08-09", weight_kg: 87.9 },
  ]);
  assert.equal(withGap.length, 3);
  assert.ok(withGap.every((p) => Number.isFinite(p.trend_kg)));
});

test("trend accepts unsorted input", () => {
  const pts = weightTrend([
    { measured_on: "2026-08-03", weight_kg: 87.5 },
    { measured_on: "2026-08-01", weight_kg: 88.0 },
  ]);
  assert.equal(pts[0].date, "2026-08-01");
});

test("weeklyTrendChange is negative while losing", () => {
  const weighins = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date("2026-08-01T00:00:00");
    d.setDate(d.getDate() + i);
    weighins.push({ measured_on: isoDate(d), weight_kg: 88.0 - i * 0.09 });
  }
  const change = weeklyTrendChange(weighins);
  assert.ok(change < 0, "should be losing");
  assert.ok(Math.abs(change) < 1.5, "and within a plausible range");
});

test("weeklyTrendChange refuses too-short windows", () => {
  assert.equal(weeklyTrendChange([{ measured_on: "2026-08-01", weight_kg: 88 }]), null);
});

// ---------------------------------------------------------------------------
// Adaptive TDEE (plan 3.1) - the worked example from the plan
// ---------------------------------------------------------------------------

test("effectiveTdee reproduces the plan's worked example", () => {
  // 7-day mean intake 2150, trend -0.55 kg/week -> deficit 605, TDEE 2755.
  const intakes = Array(14).fill(2150);
  const r = effectiveTdee(intakes, -0.55);
  assert.ok(r);
  assert.equal(Math.round(r.impliedDeficit), 605);
  assert.equal(Math.round(r.effectiveTdee), 2755);
  assert.equal(r.trustworthy, true);
});

test("effectiveTdee withholds a number below 10 days", () => {
  assert.equal(effectiveTdee(Array(9).fill(2000), -0.5), null);
});

test("effectiveTdee is shown but not trusted between 10 and 13 days", () => {
  const r = effectiveTdee(Array(11).fill(2000), -0.5);
  assert.ok(r);
  assert.equal(r.trustworthy, false);
});

test("gaining weight yields a negative deficit, i.e. a surplus", () => {
  const r = effectiveTdee(Array(14).fill(2500), +0.2);
  assert.ok(r.impliedDeficit < 0);
  assert.ok(r.effectiveTdee < 2500);
});

test("consistent estimation bias cancels out of the target", () => {
  // The core claim of plan 3.1. Two loggers, same real intake and same real weight
  // change, but one under-reports by 20%. Both must arrive at the same DEFICIT.
  const truthful = effectiveTdee(Array(14).fill(2000), -0.6);
  const biased = effectiveTdee(Array(14).fill(1600), -0.6); // 20% low, consistently
  assert.equal(
    Math.round(truthful.impliedDeficit),
    Math.round(biased.impliedDeficit),
    "deficit must be bias-invariant"
  );
  // And each one's target sits the same distance below its own measured TDEE.
  const tA = nextWeekTarget(truthful, 88, 690);
  const tB = nextWeekTarget(biased, 88, 690);
  assert.equal(truthful.effectiveTdee - tA.target, biased.effectiveTdee - tB.target);
});

// ---------------------------------------------------------------------------
// Safety ceiling (plan 3.3)
// ---------------------------------------------------------------------------

test("ceiling raises the target when losing too fast", () => {
  const tdee = effectiveTdee(Array(14).fill(1800), -1.2); // ~1.4%/wk at 88 kg
  const uncapped = nextWeekTarget(tdee, 88, 690);
  const capped = nextWeekTarget(tdee, 88, 2000); // absurd requested deficit
  assert.equal(capped.capped, true);
  assert.ok(capped.target > tdee.effectiveTdee - 2000, "target must be raised");
  assert.equal(uncapped.capped, false);
});

test("ceiling scales with current weight, not starting weight", () => {
  // 1%/week: 0.88 kg at 88 kg, 0.75 kg at 75 kg.
  assert.equal(exceedsCeiling(-0.8, 88), false);
  assert.equal(exceedsCeiling(-0.8, 75), true);
});

test("KCAL_PER_KG is the conventional 7700", () => {
  assert.equal(KCAL_PER_KG, 7700);
});

// ---------------------------------------------------------------------------
// Projection (plan 3.3)
// ---------------------------------------------------------------------------

test("required rate from 88.0 kg on 2026-08-06 is about 0.63 kg/week", () => {
  const p = project(88.0, -0.63, new Date("2026-08-06T08:00:00"));
  assert.ok(Math.abs(p.weeksRemaining - 21) < 0.2, `weeks=${p.weeksRemaining}`);
  assert.ok(
    Math.abs(p.requiredRateKg - 0.63) < 0.02,
    `required=${p.requiredRateKg.toFixed(3)}`
  );
});

test("goal weight is 15% below start", () => {
  assert.ok(Math.abs(74.8 / 88.0 - 0.85) < 0.002);
  assert.ok(Math.abs(kgToLb(88.0) - 194) < 0.15);
  assert.ok(Math.abs(kgToLb(74.8) - 164.9) < 0.2);
});

test("on-plan rate lands on time; slower rate does not", () => {
  const onPlan = project(88.0, -0.63, new Date("2026-08-06T08:00:00"));
  assert.equal(onPlan.onTrack, true);
  const slow = project(88.0, -0.40, new Date("2026-08-06T08:00:00"));
  assert.equal(slow.onTrack, false);
  assert.ok(slow.weightOnGoalDate > 74.8, "slow trend overshoots the goal weight");
});

test("a flat trend yields no finish date rather than a fake one", () => {
  const p = project(88.0, 0, new Date("2026-08-06T08:00:00"));
  assert.equal(p.finishDate, null);
  assert.equal(p.onTrack, false);
});

test("already at goal reports done", () => {
  const p = project(74.0, -0.1, new Date("2026-08-06T08:00:00"));
  assert.ok(p.finishDate);
  assert.equal(p.onTrack, true);
});

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

test("isoDate uses local time, not UTC", () => {
  // A late-evening local time must not roll into the next UTC day.
  const d = new Date(2026, 7, 6, 23, 30); // 2026-08-06 23:30 local
  assert.equal(isoDate(d), "2026-08-06");
});

test("daysBetween counts calendar days", () => {
  assert.equal(daysBetween("2026-08-06", "2026-12-31"), 147);
  assert.equal(daysBetween("2026-08-06", "2026-08-06"), 0);
});
