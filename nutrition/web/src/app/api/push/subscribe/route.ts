/**
 * POST /api/push/subscribe
 *
 * Stores a Web Push subscription so the cron job (api/cron/shabbat) can address this
 * device directly. Runs with the admin client because there is no user session cookie
 * on this route - the client already knows its own userId from the authenticated
 * Supabase session it holds locally (see lib/push.ts) and passes it explicitly, the same
 * pattern /api/estimate uses.
 */

import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase/server";

interface Body {
  userId: string;
  endpoint: string;
  keys: { p256dh?: string; auth?: string };
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const { userId, endpoint, keys } = body;
  if (!userId || !endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json(
      { error: "userId, endpoint, keys.p256dh and keys.auth are required" },
      { status: 400 }
    );
  }

  const db = adminClient();
  const { error } = await db
    .from("push_subscriptions")
    .upsert(
      { user_id: userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
      { onConflict: "user_id,endpoint" }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
