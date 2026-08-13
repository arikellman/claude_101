/**
 * POST /share
 *
 * Handles the Android Web Share Target registration in manifest.json (plan 4.6). Effect:
 * a photo taken in the plain Android camera app, or received in WhatsApp, can be shared
 * straight into the log without ever opening this app - sometimes faster than the app's
 * own camera.
 *
 * Why this can't just be a client component that reads the shared file: the OS delivers
 * the share as a full-navigation multipart POST straight to the server, with none of the
 * browser tab's state - no Supabase session, because this app's auth (createBrowserClient)
 * stores its session in localStorage, not a cookie, and localStorage from `/` is not
 * visible to this request either way.
 *
 * The route therefore does the whole job server-side with the admin client, which is a
 * deliberate, narrow use of a service-role credential outside its usual "administrative
 * task" role: this is a genuinely single-user app (see CLAUDE.md - "no sign-up flow"), so
 * "the one user" is well-defined. If this app ever supports more than one account, this
 * route needs a real per-request auth mechanism before that assumption holds.
 *
 * Untested by design here: a real Android share-sheet POST can only be exercised from an
 * installed PWA on a physical device, which this environment cannot simulate. Shape and
 * logic were verified with a scripted multipart POST (see scripts/smoke-share.mjs);
 * confirm on-device before relying on it.
 */

import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  const db = adminClient();

  try {
    const form = await req.formData();
    const file = form.get("photo");
    if (!(file instanceof File)) {
      return NextResponse.redirect(`${origin}/?share_error=no_photo`, 303);
    }

    const { data: users, error: userError } = await db.auth.admin.listUsers();
    if (userError || !users.users.length) {
      return NextResponse.redirect(`${origin}/?share_error=no_user`, 303);
    }
    const userId = users.users[0].id;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const photoPath = `${userId}/${crypto.randomUUID()}.jpg`;
    const { error: upErr } = await db.storage
      .from("photos")
      .upload(photoPath, bytes, { contentType: file.type || "image/jpeg" });
    if (upErr) return NextResponse.redirect(`${origin}/?share_error=upload_failed`, 303);

    // Default to food mode. The OS share sheet has no concept of "label vs. recipe vs.
    // food", and food is the highest-volume path by a wide margin (plan 5.5) - if this
    // guess is wrong, the entry is still fully editable from the Today list afterward.
    const { data: entry, error: insErr } = await db
      .from("entries")
      .insert({
        user_id: userId,
        source: "photo",
        mode: "food",
        photo_path: photoPath,
        status: "pending",
      })
      .select("id")
      .single();
    if (insErr || !entry) return NextResponse.redirect(`${origin}/?share_error=insert_failed`, 303);

    // Fire the estimate from the server, same as the client would - fire-and-forget so
    // the redirect isn't held up waiting on Claude.
    fetch(`${origin}/api/estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId: entry.id, userId, mode: "food", photoPath }),
    }).catch(() => {});

    return NextResponse.redirect(`${origin}/?shared=1`, 303);
  } catch (e) {
    console.error("[share]", e);
    return NextResponse.redirect(`${origin}/?share_error=unexpected`, 303);
  }
}
