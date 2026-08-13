/**
 * POST /api/push/unsubscribe
 *
 * Removes a Web Push subscription. Mirrors subscribe/route.ts - same admin-client
 * reasoning applies (no session cookie on this route, userId passed explicitly from
 * the client's own authenticated session).
 *
 * Added because Settings previously had no way to turn notifications back off once
 * enabled - the button just stayed permanently disabled.
 */

import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase/server";

interface Body {
  userId: string;
  endpoint: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const { userId, endpoint } = body;
  if (!userId || !endpoint) {
    return NextResponse.json({ error: "userId and endpoint are required" }, { status: 400 });
  }

  const db = adminClient();
  const { error } = await db
    .from("push_subscriptions")
    .delete()
    .eq("user_id", userId)
    .eq("endpoint", endpoint);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
