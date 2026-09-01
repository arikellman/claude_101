/**
 * End-to-end smoke test for the estimate pipeline.
 *
 *   node scripts/smoke-estimate.mjs <mode> <photo-path> [--keep]
 *   node scripts/smoke-estimate.mjs --cleanup
 *
 * Exercises exactly what the phone does, minus the camera: upload a photo to Storage,
 * insert a `pending` entry, POST /api/estimate, then read the row back and check the
 * write-back landed. This is the only path that actually bills the Anthropic API, so it
 * is a separate script rather than part of `preflight`.
 *
 * Rows it creates are tagged in `raw_input` with SMOKE_TAG and removed at the end unless
 * --keep is passed, so a smoke run does not pollute the food log or the products cache.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createClient } from "@supabase/supabase-js";

const SMOKE_TAG = "[smoke-test]";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3005";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, "");
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const args = process.argv.slice(2);

if (args[0] === "--cleanup") {
  await cleanup();
  process.exit(0);
}

const [mode, photoPath] = args;
const keep = args.includes("--keep");

if (!mode || !photoPath) {
  console.error("usage: node scripts/smoke-estimate.mjs <food|label|recipe> <photo-path> [--keep]");
  console.error("       node scripts/smoke-estimate.mjs --cleanup");
  process.exit(1);
}

// ---------------------------------------------------------------------------

const { data: users, error: userError } = await db.auth.admin.listUsers();
if (userError) die(`cannot list users: ${userError.message}`);
if (!users.users.length) die("no users yet - sign in through the app first");

const user = users.users[0];
console.log(`user            ${user.email}`);
console.log(`mode            ${mode}`);
console.log(`photo           ${basename(photoPath)}`);
console.log(`server          ${BASE}\n`);

// 1. Upload -----------------------------------------------------------------
// Path must start with the user id: the Storage policy is folder-scoped on it.
const bytes = readFileSync(photoPath);
const storagePath = `${user.id}/smoke-${Date.now()}.jpg`;

const { error: uploadError } = await db.storage
  .from("photos")
  .upload(storagePath, bytes, { contentType: "image/jpeg" });
if (uploadError) die(`upload failed: ${uploadError.message}`);
console.log(`✓ uploaded      ${storagePath} (${(bytes.length / 1024).toFixed(0)} KB)`);

// 2. Pending entry ----------------------------------------------------------
const { data: entry, error: insertError } = await db
  .from("entries")
  .insert({
    user_id: user.id,
    source: mode === "food" ? "photo" : mode,
    mode,
    photo_path: storagePath,
    status: "pending",
    raw_input: SMOKE_TAG,
  })
  .select()
  .single();
if (insertError) die(`insert failed: ${insertError.message}`);
console.log(`✓ pending row   ${entry.id}`);

// 3. Estimate ---------------------------------------------------------------
console.log(`\n… calling /api/estimate (8-30s)`);
const started = Date.now();

let res, payload;
try {
  res = await fetch(`${BASE}/api/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId: entry.id, userId: user.id, mode, photoPath: storagePath }),
  });
  payload = await res.json();
} catch (err) {
  die(`request failed: ${err.message}\n  is the dev server running at ${BASE}?`);
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (!res.ok) {
  console.error(`\n✗ HTTP ${res.status} after ${elapsed}s`);
  console.error(JSON.stringify(payload, null, 2));
  await finish(1);
}

console.log(`✓ HTTP 200 in   ${elapsed}s`);
console.log(`  model         ${payload.model}`);

const u = payload.usage ?? {};
console.log(
  `  tokens        in ${u.input_tokens} / out ${u.output_tokens}` +
    (u.cache_read_input_tokens ? ` / cache-read ${u.cache_read_input_tokens}` : "")
);
if (payload.cacheWarning) console.log(`  ⚠ cache       ${payload.cacheWarning}`);
console.log(`\nresult\n------\n${JSON.stringify(payload.result, null, 2)}`);

// 4. Verify write-back ------------------------------------------------------
// The HTTP 200 says Claude answered; it does not say the row was updated. Read it back.
const { data: after, error: readError } = await db
  .from("entries")
  .select("status, name, calories, protein_g, carbs_g, fat_g, confidence, ai_model")
  .eq("id", entry.id)
  .single();
if (readError) die(`read-back failed: ${readError.message}`);

console.log(`\nentry row\n---------`);
console.log(JSON.stringify(after, null, 2));

let failures = 0;
if (after.status !== "estimated") {
  console.error(`\n✗ status is '${after.status}', expected 'estimated'`);
  failures++;
}
if (!after.ai_model) {
  console.error("✗ ai_model not recorded - re-baselining history would be impossible");
  failures++;
}
// Label mode deliberately leaves calories null (a scan is not a meal). Everything else
// must produce a number, or the day's total silently under-counts.
if (mode !== "label" && (after.calories === null || after.calories === undefined)) {
  console.error("✗ calories is null");
  failures++;
}
if (mode === "label" && after.calories !== null) {
  console.error(`✗ label mode set calories to ${after.calories}, expected null`);
  failures++;
}

if (mode === "label" || mode === "recipe") {
  const { count } = await db
    .from("products")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (count > 0) console.log(`\n✓ cached to products (${count} row(s))`);
  else {
    console.error("\n✗ nothing cached to products - the second scan would re-bill the API");
    failures++;
  }
}

await finish(failures);

// ---------------------------------------------------------------------------

async function finish(failures) {
  if (keep) {
    console.log(`\n(--keep: rows left in place. Remove with --cleanup)`);
  } else {
    await cleanup();
  }
  console.log(failures ? `\n${failures} check(s) failed.\n` : `\nPipeline works end to end.\n`);
  process.exit(failures ? 1 : 0);
}

/** Remove everything any smoke run has ever created. Safe to run at any time. */
async function cleanup() {
  const { data: rows } = await db
    .from("entries")
    .select("id, photo_path")
    .like("raw_input", `${SMOKE_TAG}%`);

  const paths = (rows ?? []).map((r) => r.photo_path).filter(Boolean);
  if (paths.length) await db.storage.from("photos").remove(paths);
  if (rows?.length) await db.from("entries").delete().like("raw_input", `${SMOKE_TAG}%`);

  // Products carry no smoke marker, so scope by the photo paths the smoke runs uploaded.
  let products = 0;
  if (paths.length) {
    const { data } = await db
      .from("products")
      .delete()
      .in("recipe_photo_path", paths)
      .select("id");
    products = data?.length ?? 0;
  }

  console.log(
    `\ncleaned up: ${rows?.length ?? 0} entr${rows?.length === 1 ? "y" : "ies"}, ` +
      `${paths.length} photo(s), ${products} product(s)`
  );
}

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
