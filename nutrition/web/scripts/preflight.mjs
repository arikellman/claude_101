/**
 * Setup preflight. Run: npm run preflight
 *
 * Checks, in dependency order, that the four environment values are present and that
 * each one actually works against the live service. This exists because every failure
 * it catches otherwise surfaces as a blank screen or a stuck "pending" row, where the
 * real cause is three layers down.
 *
 * Read-only against Supabase and Anthropic. It creates nothing and bills nothing:
 * the Anthropic check lists models rather than sending a message.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Next.js loads .env.local automatically; a bare node process does not.
function loadEnvLocal() {
  let text;
  try {
    text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  } catch {
    fatal(".env.local not found. Run: cp .env.local.example .env.local");
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    // Strip surrounding quotes; Supabase's dashboard copy button sometimes includes them.
    process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const PASS = "✓";
const FAIL = "✗";
let failed = 0;

function ok(msg) {
  console.log(`${PASS} ${msg}`);
}
function bad(msg, fix) {
  console.log(`${FAIL} ${msg}`);
  if (fix) console.log(`    fix: ${fix}`);
  failed++;
}
function fatal(msg) {
  console.error(`${FAIL} ${msg}`);
  process.exit(1);
}

/** Present, non-empty, and not still the placeholder from .env.local.example. */
function present(name, placeholderFragment) {
  const v = process.env[name];
  if (!v) {
    bad(`${name} is missing`, "add it to .env.local");
    return null;
  }
  if (placeholderFragment && v.includes(placeholderFragment)) {
    bad(`${name} is still the example placeholder`, "paste the real value into .env.local");
    return null;
  }
  return v;
}

loadEnvLocal();

console.log("\nEnvironment\n-----------");

const url = present("NEXT_PUBLIC_SUPABASE_URL", "xxxxxxxxxxxx");
const anon = present("NEXT_PUBLIC_SUPABASE_ANON_KEY", "eyJ...");
const service = present("SUPABASE_SERVICE_ROLE_KEY", "eyJ...");
const anthropic = present("ANTHROPIC_API_KEY", "sk-ant-...");

if (url && anon) ok("Supabase URL and anon key present");
if (service) ok("service-role key present");
if (anthropic) ok("Anthropic key present");

// A service-role key pasted into the anon slot would silently hand full database access
// to the browser bundle. Worth one line to make that impossible to ship.
if (anon && service && anon === service) {
  bad(
    "anon key and service-role key are identical",
    "you pasted the same value twice - the anon key is the one labelled 'anon public'"
  );
}
if (anon) {
  const role = keyRole(anon);
  if (role && role !== "anon") {
    bad(
      `NEXT_PUBLIC_SUPABASE_ANON_KEY is a '${role}' key, expected the public/anon one`,
      "this key reaches the browser; a secret key there exposes the whole database"
    );
  } else if (!role) {
    bad(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY is not a recognised Supabase key",
      "expected sb_publishable_… or a legacy eyJ… JWT"
    );
  }
}
if (service) {
  const role = keyRole(service);
  if (role && role !== "service_role") {
    bad(`SUPABASE_SERVICE_ROLE_KEY is a '${role}' key, expected the secret/service_role one`);
  } else if (!role) {
    bad(
      "SUPABASE_SERVICE_ROLE_KEY is not a recognised Supabase key",
      "expected sb_secret_… or a legacy eyJ… JWT"
    );
  }
}

/**
 * Classify a Supabase key as 'anon' or 'service_role'.
 *
 * Two formats are in circulation. Current dashboards issue opaque prefixed keys
 * (sb_publishable_… / sb_secret_…); legacy projects issue JWTs carrying a `role` claim.
 * Handle both, and return null for anything unrecognised rather than treating an
 * unparseable key as safe - this check is the only thing that catches the two keys being
 * pasted into each other's slot, which would put full database access in the browser bundle.
 */
function keyRole(key) {
  if (key.startsWith("sb_publishable_")) return "anon";
  if (key.startsWith("sb_secret_")) return "service_role";

  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const role = JSON.parse(Buffer.from(parts[1], "base64url").toString()).role;
    return role === "anon" || role === "service_role" ? role : null;
  } catch {
    return null;
  }
}

if (failed) {
  console.log(`\n${failed} problem(s) in .env.local. Fix those first.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Live checks
// ---------------------------------------------------------------------------

console.log("\nSupabase\n--------");

const db = createClient(url, service, { auth: { persistSession: false } });

const TABLES = ["products", "entries", "weights", "tdee_snapshots", "combos"];
for (const t of TABLES) {
  const { error } = await db.from(t).select("*", { count: "exact", head: true });
  if (error) {
    bad(
      `table '${t}' unreachable: ${error.message}`,
      "run supabase/schema.sql in the SQL Editor"
    );
  } else {
    ok(`table '${t}'`);
  }
}

const { data: buckets, error: bucketError } = await db.storage.listBuckets();
if (bucketError) {
  bad(`storage unreachable: ${bucketError.message}`);
} else if (!buckets.some((b) => b.name === "photos")) {
  bad("storage bucket 'photos' missing", "run supabase/schema.sql in the SQL Editor");
} else {
  ok("storage bucket 'photos'");
}

// RLS is the only thing standing between the anon key and the whole table. Verify it is
// actually on rather than trusting that schema.sql ran to completion.
const anonDb = createClient(url, anon, { auth: { persistSession: false } });
const { data: leaked, error: anonError } = await anonDb.from("entries").select("id").limit(1);
if (anonError || (leaked && leaked.length === 0)) {
  ok("RLS blocks unauthenticated reads");
} else {
  bad(
    "anon key can read entries without authenticating - RLS is not enforced",
    "re-run supabase/schema.sql; do not deploy until this passes"
  );
}

console.log("\nAnthropic\n---------");

const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
  headers: { "x-api-key": anthropic, "anthropic-version": "2023-06-01" },
});

if (res.ok) {
  ok("API key valid");
} else if (res.status === 401) {
  bad("API key rejected (401)", "check the key, and that it is from your personal org");
} else if (res.status === 400 || res.status === 429) {
  const body = await res.text();
  bad(
    `API returned ${res.status}: ${body.slice(0, 200)}`,
    "if this mentions credit balance, add credits at console.anthropic.com/settings/billing"
  );
} else {
  bad(`API returned ${res.status}`);
}

console.log(
  failed
    ? `\n${failed} check(s) failed.\n`
    : "\nAll checks passed. Run: npm run dev\n"
);
process.exit(failed ? 1 : 0);
