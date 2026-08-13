/**
 * Smoke test for the Web Share Target route (/share).
 *
 *   node scripts/smoke-share.mjs <photo-path>
 *
 * Posts a real multipart/form-data body shaped exactly like the Android share sheet
 * would (manifest.json's share_target declares field name "photo"), then verifies the
 * redirect landed and a real entry got created and estimated. This is the part of the
 * share-target flow that can be verified without a physical device: the request shape,
 * the server-side logic, and the resulting DB state. It cannot verify that Android's
 * actual share sheet invokes it correctly - that needs an on-device test after install.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3005";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, "");
}

const photoPath = process.argv[2];
if (!photoPath) {
  console.error("usage: node scripts/smoke-share.mjs <photo-path>");
  process.exit(1);
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log(`photo    ${basename(photoPath)}`);
console.log(`server   ${BASE}\n`);

const bytes = readFileSync(photoPath);
const form = new FormData();
form.append("photo", new Blob([bytes], { type: "image/jpeg" }), basename(photoPath));

const before = Date.now();
const res = await fetch(`${BASE}/share`, { method: "POST", body: form, redirect: "manual" });

// A route that calls NextResponse.redirect() returns an opaqueredirect in browser fetch,
// but Node's fetch surfaces it as a normal 303 response we can inspect directly.
console.log(`HTTP ${res.status} ${res.status === 303 ? "(redirect, as expected)" : "(unexpected)"}`);
const location = res.headers.get("location");
console.log(`Location: ${location}`);

if (res.status !== 303) {
  console.error("\n✗ expected a 303 redirect");
  process.exit(1);
}
if (location?.includes("share_error")) {
  console.error(`\n✗ route redirected with an error: ${location}`);
  process.exit(1);
}

// The estimate call is fire-and-forget from the route's perspective - give it a moment,
// then read back the most recent entry with a photo to confirm it actually landed.
await new Promise((r) => setTimeout(r, 12_000));

const { data: entries, error } = await db
  .from("entries")
  .select("id, status, name, calories, ai_model, photo_path, created_at")
  .eq("source", "photo")
  .eq("mode", "food")
  .order("created_at", { ascending: false })
  .limit(1);

if (error) {
  console.error(`\n✗ read-back failed: ${error.message}`);
  process.exit(1);
}
const entry = entries?.[0];
if (!entry || new Date(entry.created_at).getTime() < before) {
  console.error("\n✗ no matching entry was created");
  process.exit(1);
}

console.log(`\nentry\n-----\n${JSON.stringify(entry, null, 2)}`);

let failures = 0;
if (entry.status !== "estimated") {
  console.error(`✗ status is '${entry.status}', expected 'estimated'`);
  failures++;
}
if (!entry.ai_model) {
  console.error("✗ ai_model not recorded");
  failures++;
}

// Clean up - this was a smoke test, not a real log.
await db.storage.from("photos").remove([entry.photo_path]);
await db.from("entries").delete().eq("id", entry.id);
console.log(`\ncleaned up entry ${entry.id}`);

console.log(failures ? `\n${failures} check(s) failed.\n` : "\n/share works end to end.\n");
process.exit(failures ? 1 : 0);
