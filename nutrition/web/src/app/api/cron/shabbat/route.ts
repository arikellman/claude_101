/**
 * GET /api/cron/shabbat
 *
 * Triggered every 15 minutes by Vercel Cron (see vercel.json). For each user:
 *   1. Ensure this week's zmanim are cached in `shabbat_plans` (fetching from Hebcal
 *      if missing or if the cached row is for a past week).
 *   2. Ask lib/shabbatSchedule.ts whether a notification is due right now.
 *   3. If so, push it to every subscribed device and record that it fired.
 *
 * Idempotent by construction: each notification stage has its own `notified_*_at`
 * column, so a cron tick that overlaps the previous one (or a retry after a timeout)
 * cannot double-send - dueNotification() returns null once that column is set.
 */

import { NextResponse } from "next/server";
import webpush from "web-push";
import { adminClient } from "@/lib/supabase/server";
import { fetchZmanim, fridayOf } from "@/lib/hebcal";
import { dueNotification, copyFor, type NotificationState } from "@/lib/shabbatSchedule";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT; // mailto: address, required by the push spec

export async function GET(req: Request) {
  // Cron routes are public URLs by default. CRON_SECRET keeps this from being triggered
  // by anyone who finds the path - Vercel Cron sends it automatically as a bearer token
  // when configured; see the README for the manual-curl equivalent during testing.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    return NextResponse.json(
      { error: "VAPID keys not configured - see .env.local.example" },
      { status: 500 }
    );
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const db = adminClient();
  const now = new Date();
  const results: Array<{ userId: string; sent: string | null; error?: string }> = [];

  const { data: users, error: userError } = await db.auth.admin.listUsers();
  if (userError) return NextResponse.json({ error: userError.message }, { status: 500 });

  for (const user of users.users) {
    try {
      const sent = await processUser(db, user.id, now);
      results.push({ userId: user.id, sent });
    } catch (e) {
      results.push({ userId: user.id, sent: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ ranAt: now.toISOString(), results });
}

type Db = ReturnType<typeof adminClient>;

async function processUser(db: Db, userId: string, now: Date): Promise<string | null> {
  const { data: settings } = await db
    .from("settings")
    .select("geonameid")
    .eq("user_id", userId)
    .maybeSingle();
  const geonameid = settings?.geonameid ?? 293397; // Tel Aviv default - see schema.sql

  const weekStart = fridayOf(now);
  let plan = (
    await db
      .from("shabbat_plans")
      .select("*")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle()
  ).data;

  // Refetch zmanim if this week has no cached row yet. Not re-fetched once cached -
  // candle/havdalah times for a given week don't change, so there is nothing to refresh.
  if (!plan) {
    const z = await fetchZmanim(geonameid, weekStart);
    const { data: created, error } = await db
      .from("shabbat_plans")
      .upsert(
        {
          user_id: userId,
          week_start: weekStart,
          candle_lighting: z.candleLighting?.toISOString() ?? null,
          havdalah: z.havdalah?.toISOString() ?? null,
          is_yomtov: z.isYomTov,
        },
        { onConflict: "user_id,week_start" }
      )
      .select("*")
      .single();
    if (error) throw new Error(`caching zmanim failed: ${error.message}`);
    plan = created;
  }

  if (!plan.candle_lighting || !plan.havdalah) return null; // Hebcal returned nothing usable

  const state: NotificationState = {
    candleLighting: new Date(plan.candle_lighting),
    havdalah: new Date(plan.havdalah),
    reconciledAt: plan.reconciled_at ? new Date(plan.reconciled_at) : null,
    notifiedPrepAt: plan.notified_prep_at ? new Date(plan.notified_prep_at) : null,
    notifiedRecon1At: plan.notified_recon_1_at ? new Date(plan.notified_recon_1_at) : null,
    notifiedRecon2At: plan.notified_recon_2_at ? new Date(plan.notified_recon_2_at) : null,
    notifiedRecon3At: plan.notified_recon_3_at ? new Date(plan.notified_recon_3_at) : null,
  };

  const due = dueNotification(state, now);
  if (!due) return null;

  const { data: subs } = await db
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", userId);

  const copy = copyFor(due);
  await Promise.all(
    (subs ?? []).map((sub) =>
      webpush
        .sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: copy.title, body: copy.body, url: copy.url, tag: copy.tag })
        )
        .catch(async (err: { statusCode?: number }) => {
          // 404/410 means the browser revoked this subscription (uninstalled, cleared
          // data). Prune it rather than retrying forever against a dead endpoint.
          if (err.statusCode === 404 || err.statusCode === 410) {
            await db.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
          }
        })
    )
  );

  const column = {
    prep: "notified_prep_at",
    recon1: "notified_recon_1_at",
    recon2: "notified_recon_2_at",
    recon3: "notified_recon_3_at",
  }[due];
  await db.from("shabbat_plans").update({ [column]: now.toISOString() }).eq("id", plan.id);

  return due;
}
