/**
 * One-off historical backfill for wearable_daily, beyond the cron's normal 7-day
 * rolling window. Use this after a gap (e.g. the strap died/wasn't charged) once it's
 * back online and synced to the Zepp app, or the first time this feature is turned on,
 * so Trend has more than a few days of history to show right away.
 *
 * Reuses the same login + decode as lib/zepp.ts and api/cron/wearable-sync - this only
 * adds a wider --days window and writes with the service-role key from the CLI instead
 * of from the deployed cron route.
 *
 *   node scripts/zepp-backfill.mjs --days 90
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, "");
}

const { fetchRecentWearableDays } = await import("../src/lib/zepp.ts");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const DAYS = parseInt(flag("--days", "90"), 10);

const email = process.env.ZEPP_EMAIL;
const password = process.env.ZEPP_PASSWORD;
const targetUserId = process.env.ZEPP_USER_ID;
if (!email || !password || !targetUserId) {
  console.error("Missing ZEPP_EMAIL, ZEPP_PASSWORD, or ZEPP_USER_ID in .env.local");
  process.exit(1);
}

console.log(`Logging in and pulling the last ${DAYS} days...`);
const days = await fetchRecentWearableDays(email, password, DAYS, process.env.ZEPP_HOST);
console.log(`Zepp returned ${days.length} day(s) with data (gaps mean the band wasn't synced that day).`);

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const rows = days.map((d) => ({
  user_id: targetUserId,
  date: d.date,
  source: "zepp",
  steps: d.steps,
  active_calories: d.activeCalories,
  sleep_minutes: d.sleepMinutes,
  deep_sleep_minutes: d.deepSleepMinutes,
  resting_hr: d.restingHr,
  raw: d,
  synced_at: new Date().toISOString(),
}));

const { error } = await db.from("wearable_daily").upsert(rows, { onConflict: "user_id,date,source" });
if (error) {
  console.error("Upsert failed:", error.message);
  process.exit(1);
}

console.log(`Upserted ${rows.length} rows: ${rows[0]?.date} .. ${rows[rows.length - 1]?.date}`);
