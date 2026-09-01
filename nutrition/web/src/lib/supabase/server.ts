/**
 * Server-only Supabase client. NEVER import this from a "use client" component.
 *
 * This module is deliberately separate from ./client.ts. Co-locating them pulls the
 * service-role key and server-only Next APIs into the browser bundle, which is both a
 * build failure and a credential leak waiting to happen.
 */

import { createClient } from "@supabase/supabase-js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.local.example`);
  return v;
}

/**
 * Service-role client. BYPASSES Row Level Security.
 *
 * The estimate route needs this because the Claude call outlives the browser session that
 * started it: you snap a photo, lock the phone, and the write-back happens with no live
 * user context to authenticate against.
 *
 * Because RLS is bypassed, every query made with this client MUST filter by user_id
 * explicitly. Nothing else is stopping a forged entryId from writing to another row.
 */
export function adminClient() {
  return createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
