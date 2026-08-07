/**
 * Nutrition and weight-trend math. Pure functions only - no I/O, no React, no Supabase,
 * so this is unit-testable and the numbers can be checked independently of the UI.
 *
 * Every constant traces to a section of nutrition-app-plan.md. Do not tune these
 * casually: the calorie split and the Friday week boundary in particular are load-bearing.
 */

// ---------------------------------------------------------------------------
// Goal constants (plan 3.3). Start 194 lb / 88.0 kg on 2026-08-06, target 15% loss
// to 164.9 lb / 74.8 kg by 2026-12-31 - 21 weeks at 0.71% body weight per week.
// ---------------------------------------------------------------------------

export const START_WEIGHT_KG = 88.0;
export const GOAL_WEIGHT_KG = 74.8;
export const GOAL_DATE = "2026-12-31";

/** kcal per kg of body mass. The conventional figure for mixed tissue loss. */
export const KCAL_PER_KG = 7700;

/** Protein floor in grams/day: 2.0 g per kg of TARGET weight (74.8 kg), rounded. */
export const PROTEIN_FLOOR_G = 150;

/**
 * Weekly calorie budget, allocated unevenly so Shabbat is absorbed by design
 * rather than showing up as a failure (plan 3.3 / 10.4).
 * JS getDay(): 0 = Sunday ... 6 = Saturday.
 */
export const DAILY_BUDGET: Record<number, number> = {
  0: 1800, // Sunday
  1: 1800, // Monday
  2: 1800, // Tuesday
  3: 1800, // Wednesday
  4: 1800, // Thursday
  5: 2150, // Friday - includes Friday night dinner
  6: 2500, // Saturday - includes lunch and seudah shlishit
};

export const WEEKLY_BUDGET = Object.values(DAILY_BUDGET).reduce((a, b) => a + b, 0); // 13,650

/**
 * Deficit ceiling as a fraction of CURRENT body weight per week. Above this for two
 * consecutive weeks and the target should be raised, not celebrated (plan 3.3).
 */
export const MAX_WEEKLY_LOSS_FRACTION = 0.01;

/** EWMA smoothing factor for the weight trend (Hacker's Diet method, plan 3.2). */
export const TREND_ALPHA = 0.25;

/** Days of data required before the adaptive TDEE number is shown / trusted (plan 3.1). */
export const TDEE_MIN_DAYS_SHOW = 10;
export const TDEE_MIN_DAYS_TRUST = 14;

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const kgToLb = (kg: number): number => kg * 2.2046226218;
export const lbToKg = (lb: number): number => lb / 2.2046226218;

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Calorie allocation for a given date. */
export function dailyBudget(date: Date): number {
  return DAILY_BUDGET[date.getDay()];
}

export interface WeekBoundary {
  /** Inclusive start (the Saturday after the previous Friday checkpoint). */
  start: Date;
  /** Inclusive end - always a Friday (plan 3.2). */
  end: Date;
}

/**
 * The week containing `date`, running Friday to Friday.
 *
 * Sunday is the worst day of the week to read a weight - Shabbat food is carb- and
 * salt-heavy, so Sunday runs 1-3 lb high on water alone. Anchoring the week to Friday
 * morning (post-weekday, pre-Shabbat) gives the most consistently-conditioned
 * comparison point and keeps that noise out of the TDEE calculation.
 */
export function weekBoundary(date: Date): WeekBoundary {
  const end = startOfDay(date);
  // Walk forward to the next Friday (getDay() === 5), staying put if already Friday.
  const daysToFriday = (5 - end.getDay() + 7) % 7;
  end.setDate(end.getDate() + daysToFriday);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { start, end };
}

/** Budget remaining in the current Friday-to-Friday week, given intake so far. */
export function weeklyRemaining(
  date: Date,
  intakeByDay: Map<string, number>
): { budget: number; consumed: number; remaining: number; daysElapsed: number } {
  const { start } = weekBoundary(date);
  let budget = 0;
  let consumed = 0;
  let daysElapsed = 0;
  const today = startOfDay(date);

  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    budget += dailyBudget(d);
    consumed += intakeByDay.get(isoDate(d)) ?? 0;
    daysElapsed += 1;
  }
  return { budget, consumed, remaining: budget - consumed, daysElapsed };
}

// ---------------------------------------------------------------------------
// Weight trend
// ---------------------------------------------------------------------------

export interface Weighin {
  measured_on: string; // ISO date
  weight_kg: number;
}

export interface TrendPoint {
  date: string;
  weight_kg: number;
  trend_kg: number;
}

/**
 * Exponentially-weighted moving average over weigh-ins.
 *
 * Gaps are absorbed without distortion, which is what makes this the right choice for a
 * Shabbat-observant user: no Saturday weigh-in is simply a missing observation, not a
 * zero. Input need not be sorted or gap-free.
 */
export function weightTrend(weighins: Weighin[], alpha = TREND_ALPHA): TrendPoint[] {
  const sorted = [...weighins].sort((a, b) => a.measured_on.localeCompare(b.measured_on));
  let trend: number | null = null;
  return sorted.map((w) => {
    trend = trend === null ? w.weight_kg : trend + alpha * (w.weight_kg - trend);
    return { date: w.measured_on, weight_kg: w.weight_kg, trend_kg: trend };
  });
}

/** Most recent trend value, or null if there are no weigh-ins. */
export function currentTrend(weighins: Weighin[]): number | null {
  const pts = weightTrend(weighins);
  return pts.length ? pts[pts.length - 1].trend_kg : null;
}

/**
 * Trend change in kg per week, measured over the trailing `days` window.
 * Negative means losing. Returns null without enough spread to be meaningful.
 */
export function weeklyTrendChange(weighins: Weighin[], days = 7): number | null {
  const pts = weightTrend(weighins);
  if (pts.length < 2) return null;

  const last = pts[pts.length - 1];
  const cutoff = new Date(last.date);
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = isoDate(cutoff);

  // Earliest point at or after the cutoff; falls back to the first point available.
  const first = pts.find((p) => p.date >= cutoffIso) ?? pts[0];
  const spanDays = daysBetween(first.date, last.date);
  if (spanDays < 3) return null; // too short to divide by without amplifying noise

  return ((last.trend_kg - first.trend_kg) / spanDays) * 7;
}

// ---------------------------------------------------------------------------
// Adaptive TDEE (plan 3.1) - the engine
// ---------------------------------------------------------------------------

export interface TdeeResult {
  /** Expenditure in the app's own (systematically biased) intake units. */
  effectiveTdee: number;
  meanIntake: number;
  trendChangeKg: number;
  impliedDeficit: number;
  daysLogged: number;
  /** True once there is enough data to drive the target, not just display it. */
  trustworthy: boolean;
}

/**
 * Solve for expenditure instead of guessing it.
 *
 *     effectiveTDEE = mean logged intake + (weekly weight change x 7700 / 7)
 *
 * The result is NOT physiological TDEE. It is expenditure expressed in the same
 * systematically-biased units the app measures intake in - which is exactly what is
 * needed, because the target it produces is in those same units. If the vision model
 * runs 15% low, that bias is absorbed here and cancels out of the target.
 *
 * This is why estimation CONSISTENCY matters and estimation ACCURACY largely does not,
 * and why the model must not be changed mid-run without re-baselining.
 */
export function effectiveTdee(
  dailyIntakes: number[],
  trendChangeKg: number
): TdeeResult | null {
  const daysLogged = dailyIntakes.length;
  if (daysLogged < TDEE_MIN_DAYS_SHOW) return null;

  const meanIntake = dailyIntakes.reduce((a, b) => a + b, 0) / daysLogged;
  // Negative trendChange (losing weight) must produce a POSITIVE deficit.
  const impliedDeficit = (-trendChangeKg * KCAL_PER_KG) / 7;

  return {
    effectiveTdee: meanIntake + impliedDeficit,
    meanIntake,
    trendChangeKg,
    impliedDeficit,
    daysLogged,
    trustworthy: daysLogged >= TDEE_MIN_DAYS_TRUST,
  };
}

/**
 * Next week's daily target from a measured TDEE, with the safety ceiling applied.
 *
 * If the trailing trend is already losing faster than 1%/week, the target goes UP.
 * The ceiling is recomputed against current weight, not starting weight, because the
 * same percentage is a smaller absolute deficit as you get lighter.
 */
export function nextWeekTarget(
  tdee: TdeeResult,
  currentWeightKg: number,
  desiredDeficit = 690
): { target: number; capped: boolean; reason: string } {
  const maxWeeklyLossKg = currentWeightKg * MAX_WEEKLY_LOSS_FRACTION;
  const maxDailyDeficit = (maxWeeklyLossKg * KCAL_PER_KG) / 7;

  if (desiredDeficit > maxDailyDeficit) {
    return {
      target: Math.round(tdee.effectiveTdee - maxDailyDeficit),
      capped: true,
      reason:
        `Deficit capped at ${Math.round(maxDailyDeficit)} kcal/day ` +
        `(1%/week of ${currentWeightKg.toFixed(1)} kg) to protect lean mass.`,
    };
  }
  return {
    target: Math.round(tdee.effectiveTdee - desiredDeficit),
    capped: false,
    reason: `On plan at a ${desiredDeficit} kcal/day deficit.`,
  };
}

/** True when the trailing trend is losing faster than the ceiling allows. */
export function exceedsCeiling(trendChangeKg: number, currentWeightKg: number): boolean {
  return -trendChangeKg > currentWeightKg * MAX_WEEKLY_LOSS_FRACTION;
}

// ---------------------------------------------------------------------------
// Projection (plan 3.3) - the headline metric
// ---------------------------------------------------------------------------

export interface Projection {
  /** Projected date of reaching goal weight at the current trend, or null if not losing. */
  finishDate: Date | null;
  /** Projected weight on GOAL_DATE at the current trend. */
  weightOnGoalDate: number;
  /** Weeks remaining until GOAL_DATE. */
  weeksRemaining: number;
  /** Rate needed from here to hit GOAL_DATE, kg/week. */
  requiredRateKg: number;
  onTrack: boolean;
}

/**
 * Project forward from the current trend.
 *
 * Deliberately reports a projected FINISH DATE rather than a percentage-complete bar, so
 * you are steering on the real slope instead of on cumulative loss. A percentage bar
 * looks healthiest exactly when the trend has gone flat.
 */
export function project(
  currentTrendKg: number,
  weeklyChangeKg: number,
  today = new Date()
): Projection {
  const weeksRemaining = Math.max(0, daysBetween(isoDate(today), GOAL_DATE) / 7);
  const toLose = currentTrendKg - GOAL_WEIGHT_KG;

  const requiredRateKg = weeksRemaining > 0 ? toLose / weeksRemaining : 0;
  const weightOnGoalDate = currentTrendKg + weeklyChangeKg * weeksRemaining;

  let finishDate: Date | null = null;
  if (weeklyChangeKg < -0.01 && toLose > 0) {
    const weeksNeeded = toLose / -weeklyChangeKg;
    finishDate = startOfDay(today);
    finishDate.setDate(finishDate.getDate() + Math.round(weeksNeeded * 7));
  } else if (toLose <= 0) {
    finishDate = startOfDay(today); // already there
  }

  return {
    finishDate,
    weightOnGoalDate,
    weeksRemaining,
    requiredRateKg,
    // Compare as calendar dates, never as Date objects. `new Date("2026-12-31")` parses
    // as UTC midnight while finishDate is local, so a direct <= comparison is off by a
    // day in any timezone east of UTC - which is where this app is used.
    onTrack: finishDate !== null && isoDate(finishDate) <= GOAL_DATE,
  };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** Local-time ISO date (YYYY-MM-DD). Deliberately not toISOString(), which is UTC. */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function daysBetween(isoA: string, isoB: string): number {
  const a = new Date(`${isoA}T00:00:00`);
  const b = new Date(`${isoB}T00:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
