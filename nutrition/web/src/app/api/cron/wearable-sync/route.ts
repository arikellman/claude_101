/**
 * GET /api/cron/wearable-sync
 *
 * Triggered daily by Vercel Cron (see vercel.json). Logs into Zepp fresh (no token
 * caching - see lib/zepp.ts) and upserts the last 7 days of steps/sleep/resting-HR into
 * `wearable_daily`. A 7-day rolling window, not just "yesterday", absorbs Zepp's own
 * sync lag between the strap, the phone, and their servers - a day that was incomplete
 * on a previous run gets filled in on a later one via the unique(user_id, date, source)
 * upsert.
 *
 * Unlike the Shabbat cron, this does not loop over every Supabase user: Zepp
 * credentials are for exactly one Zepp account, attributed to exactly one app user via
 * ZEPP_USER_ID (a Supabase auth user id, not the Zepp account's own numeric id).
 */

import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase/server";
import { fetchRecentWearableDays } from "@/lib/zepp";

const SYNC_WINDOW_DAYS = 7;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const email = process.env.ZEPP_EMAIL;
  const password = process.env.ZEPP_PASSWORD;
  const targetUserId = process.env.ZEPP_USER_ID;
  if (!email || !password || !targetUserId) {
    return NextResponse.json(
      { error: "ZEPP_EMAIL, ZEPP_PASSWORD, or ZEPP_USER_ID not configured - see .env.local.example" },
      { status: 500 }
    );
  }

  let days;
  try {
    days = await fetchRecentWearableDays(email, password, SYNC_WINDOW_DAYS, process.env.ZEPP_HOST);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }

  const db = adminClient();
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

  const { error } = await db
    .from("wearable_daily")
    .upsert(rows, { onConflict: "user_id,date,source" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ syncedDays: rows.map((r) => r.date) });
}
