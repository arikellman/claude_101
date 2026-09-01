/**
 * Browser Supabase client. Safe to import from "use client" components.
 *
 * Only the anon key appears here; Row Level Security is the actual security boundary.
 * Nothing in this file may import from ./server.ts, or the service-role key and
 * next/headers end up in the client bundle.
 */

import { createBrowserClient } from "@supabase/ssr";

/**
 * These two reads must stay written out longhand as static `process.env.NEXT_PUBLIC_*`
 * property accesses.
 *
 * There is no `process` in the browser. The bundler substitutes each literal
 * `process.env.NEXT_PUBLIC_FOO` occurrence with the value at compile time, which is a
 * textual substitution - it cannot resolve a computed key like `process.env[name]`. Doing
 * that leaves `undefined` in the client bundle at runtime while the server, which has a
 * real `process.env`, keeps working. The failure therefore shows up only in a browser and
 * only as a blank page, with every server-side check still green.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.local.example`);
  return value;
}

// Wrapped in a non-generic factory on purpose. `ReturnType<typeof createBrowserClient>`
// instantiates the generic with its defaults and degrades parts of the client to `any`,
// which then shows up as implicit-any errors at every call site under `strict`.
function create() {
  return createBrowserClient(
    required("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY", SUPABASE_ANON_KEY)
  );
}

type BrowserClient = ReturnType<typeof create>;

let cached: BrowserClient | null = null;

/**
 * Lazily-constructed singleton browser client.
 *
 * Call this from effects and event handlers only - never during render. A "use client"
 * page still gets a server-side prerender pass, and constructing the client there both
 * wastes work and blows up the build when env vars are not yet inlined. Keeping
 * construction inside effects means it only ever happens in a real browser.
 *
 * The singleton also avoids spawning a fresh Realtime connection on every render.
 */
export function browserClient(): BrowserClient {
  cached ??= create();
  return cached;
}
