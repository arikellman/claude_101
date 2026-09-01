/**
 * POST /api/estimate
 *
 * Runs one nutrition estimation and writes the result back to an entry row.
 *
 * The API key lives here and only here - never in the browser bundle.
 *
 * Flow: the client has already created a `pending` entry and uploaded the photo, so it can
 * show the log instantly and let the user lock the phone. This route does the slow part.
 * On completion it updates the row, and Supabase Realtime pushes the change to whatever
 * client is listening - foreground or not.
 */

import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { MODEL_BY_MODE, MODES, PROMPT_VERSION, frequentItemsBlock, type Mode } from "@/lib/prompts";
import { adminClient } from "@/lib/supabase/server";
import { sumItems, type ItemsResult, type LabelResult, type RecipeResult } from "@/lib/types";

// Estimation can take 8-26s (measured). Comfortably over Vercel's 10s Hobby default.
export const maxDuration = 60;

const MODES_WITH_IMAGE = new Set<Mode>(["food", "label", "recipe"]);

interface Body {
  entryId: string;
  userId: string;
  mode: Mode;
  /** Storage path within the `photos` bucket. Required for image modes. */
  photoPath?: string;
  /** Transcript for voice mode. */
  text?: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const { entryId, userId, mode, photoPath, text } = body;

  if (!entryId || !userId || !mode || !(mode in MODES)) {
    return NextResponse.json(
      { error: "entryId, userId and a valid mode are required" },
      { status: 400 }
    );
  }
  if (MODES_WITH_IMAGE.has(mode) && !photoPath) {
    return NextResponse.json({ error: `mode '${mode}' requires photoPath` }, { status: 400 });
  }
  if (mode === "voice" && !text?.trim()) {
    return NextResponse.json({ error: "mode 'voice' requires text" }, { status: 400 });
  }

  const db = adminClient();
  const model = MODEL_BY_MODE[mode];

  try {
    // ----------------------------------------------------------------------
    // Build the user content
    // ----------------------------------------------------------------------
    const content: Anthropic.ContentBlockParam[] = [];

    if (MODES_WITH_IMAGE.has(mode)) {
      const { data, error } = await db.storage.from("photos").download(photoPath!);
      if (error || !data) throw new Error(`Photo not found at ${photoPath}: ${error?.message}`);

      const bytes = Buffer.from(await data.arrayBuffer());
      // Client downsamples to 1100px before upload, so this is ~150-250KB.
      const mediaType = data.type === "image/png" ? "image/png" : "image/jpeg";
      content.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
      });
      content.push({ type: "text", text: MODES[mode].userText });
    } else {
      content.push({ type: "text", text: MODES[mode].userText + text!.trim() });
    }

    // ----------------------------------------------------------------------
    // System prompt: stable block carries the cache breakpoint; the volatile
    // frequent-items block goes after it so it cannot invalidate the cache.
    // ----------------------------------------------------------------------
    const system: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: MODES[mode].system,
        cache_control: { type: "ephemeral" },
      },
    ];

    if (mode === "food" || mode === "voice") {
      const frequent = await topProducts(db, userId);
      const block = frequentItemsBlock(frequent);
      if (block) system.push({ type: "text", text: block });
    }

    // ----------------------------------------------------------------------
    // Call Claude. Structured outputs guarantee schema-valid JSON, so there is
    // no parse-retry loop to write.
    // ----------------------------------------------------------------------
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY
    const response = await client.messages.create({
      model,
      max_tokens: 4096, // headroom for thinking plus the JSON payload
      system,
      messages: [{ role: "user", content }],
      output_config: {
        // Thinking is on by default on these models; "low" effort improves portion
        // reasoning at negligible cost.
        effort: "low",
        format: { type: "json_schema", schema: MODES[mode].schema },
      },
    } as Anthropic.MessageCreateParamsNonStreaming);

    // Always check stop_reason before reading content. Safety classifiers can decline a
    // request and return HTTP 200 with an empty content array.
    if (response.stop_reason === "refusal") {
      return await fail(db, entryId, "Request was declined by safety classifiers.");
    }
    if (response.stop_reason === "max_tokens") {
      return await fail(db, entryId, "Response truncated - raise max_tokens.");
    }

    const payload = response.content.find((b) => b.type === "text");
    if (!payload || payload.type !== "text") {
      return await fail(db, entryId, "No text block in response.");
    }

    const result = JSON.parse(payload.text);

    // ----------------------------------------------------------------------
    // Write back
    // ----------------------------------------------------------------------
    const patch = buildPatch(mode, result);

    // user_id is filtered explicitly: adminClient bypasses RLS, so this is the only
    // thing stopping a bad entryId from writing to another user's row.
    const { error: updateError } = await db
      .from("entries")
      .update({
        ...patch,
        status: "estimated",
        ai_model: `${model}@${PROMPT_VERSION}`,
        ai_raw: result,
      })
      .eq("id", entryId)
      .eq("user_id", userId);

    if (updateError) throw new Error(`Write-back failed: ${updateError.message}`);

    // Label and recipe modes also produce a reusable product. Cache it so the second
    // time you eat this, it is an instant local hit with no API call.
    //
    // A cache miss is not worth failing the request over - the estimate itself already
    // succeeded and is written. But it must not be silent either: unnoticed, it means
    // every future scan of this product re-bills the API. Surface it as a warning.
    let cacheWarning: string | null = null;
    if (mode === "label") {
      cacheWarning = await cacheLabel(db, userId, result as LabelResult, photoPath);
    }
    if (mode === "recipe") {
      cacheWarning = await cacheRecipe(db, userId, result as RecipeResult, photoPath);
    }
    if (cacheWarning) console.error("[estimate] product cache failed:", entryId, cacheWarning);

    return NextResponse.json({
      ok: true,
      model,
      usage: response.usage,
      result,
      ...(cacheWarning ? { cacheWarning } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[estimate]", entryId, message);
    return await fail(db, entryId, message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof adminClient>;

/** Mark the entry failed so the UI can show a retry affordance rather than a spinner. */
async function fail(db: Db, entryId: string, message: string) {
  await db.from("entries").update({ status: "failed", raw_input: message }).eq("id", entryId);
  return NextResponse.json({ error: message }, { status: 502 });
}

/** The user's most-logged items, for the frequent-items prompt block. */
async function topProducts(db: Db, userId: string): Promise<string[]> {
  const { data } = await db
    .from("products")
    .select("name")
    .eq("user_id", userId)
    .order("times_logged", { ascending: false })
    .limit(15);
  return (data ?? []).map((p: { name: string }) => p.name);
}

/** Flatten a mode-specific result into entry columns. */
function buildPatch(mode: Mode, result: unknown) {
  if (mode === "food" || mode === "voice") {
    const r = result as ItemsResult;
    const t = sumItems(r.items);
    return {
      name: r.items.map((i) => i.name).join(", ") || "Unidentified",
      confidence: r.overall_confidence,
      ...t,
    };
  }

  if (mode === "label") {
    const r = result as LabelResult;
    // A label alone is not a meal - it records the product. Calories stay null until the
    // user says how much they ate, so an un-eaten scan never inflates the day's total.
    return {
      name: r.product_name || r.product_name_he || "Unnamed product",
      confidence: r.confidence,
      calories: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null,
    };
  }

  const r = result as RecipeResult;
  return {
    name: r.dish_name || r.dish_name_he || "Unnamed dish",
    confidence: r.confidence,
    calories: Math.round(r.per_serving.calories),
    protein_g: Math.round(r.per_serving.protein_g),
    carbs_g: Math.round(r.per_serving.carbs_g),
    fat_g: Math.round(r.per_serving.fat_g),
    fiber_g: Math.round(r.per_serving.fiber_g),
  };
}

/**
 * Insert a product, replacing an existing row with the same barcode.
 *
 * Deliberately not `upsert`. The uniqueness rule in schema.sql is a *partial* index on the
 * expression `(coalesce(user_id::text, 'global'), barcode) where barcode is not null`, and
 * PostgREST's `onConflict` needs a real constraint whose columns it can name. Passing
 * "user_id,barcode" matches nothing, so every write errored - silently, because the caller
 * never checked the result. The smoke test found it by reading the products table back.
 *
 * Barcodes are usually absent here anyway: a nutrition panel is generally photographed
 * without the barcode in frame, and the partial index does not constrain those rows at all.
 * So look the row up when there is a barcode to match on, and plain-insert when there is not.
 *
 * Returns null on success, or a message describing the failure.
 */
async function upsertProduct(
  db: Db,
  row: Record<string, unknown>,
  barcode: string | null
): Promise<string | null> {
  if (barcode) {
    const { data: existing, error: lookupError } = await db
      .from("products")
      .select("id")
      .eq("user_id", row.user_id as string)
      .eq("barcode", barcode)
      .maybeSingle();

    if (lookupError) return `lookup: ${lookupError.message}`;

    if (existing) {
      const { error } = await db.from("products").update(row).eq("id", existing.id);
      return error ? `update: ${error.message}` : null;
    }
  }

  const { error } = await db.from("products").insert(row);
  return error ? `insert: ${error.message}` : null;
}

async function cacheLabel(db: Db, userId: string, r: LabelResult, photoPath?: string) {
  const barcode = r.barcode || null;
  return upsertProduct(
    db,
    {
      user_id: userId,
      barcode,
      name: r.product_name || r.product_name_he || "Unnamed product",
      name_he: r.product_name_he || null,
      brand: r.brand || null,
      per_100g: r.per_100g,
      // The schema treats an unknown serving as null. The model returns 0 for "not stated
      // on the label", which would otherwise persist as a real zero-gram serving.
      serving_grams: r.serving_grams || null,
      serving_label: r.serving_label || null,
      source: "label_ocr",
      recipe_photo_path: photoPath ?? null,
    },
    barcode
  );
}

async function cacheRecipe(db: Db, userId: string, r: RecipeResult, photoPath?: string) {
  const servings = r.servings_assumed || 1;
  return upsertProduct(
    db,
    {
      user_id: userId,
      name: r.dish_name || r.dish_name_he || "Unnamed dish",
      name_he: r.dish_name_he || null,
      // Store per-100g so a recipe dish behaves like any other product downstream.
      per_100g: per100gFrom(r),
      serving_grams: r.per_serving.grams || null,
      serving_label: `1 of ${servings} servings`,
      source: "recipe_ocr",
      recipe_raw: r,
      recipe_photo_path: photoPath ?? null,
    },
    null
  );
}

function per100gFrom(r: RecipeResult) {
  const g = r.per_serving.grams;
  if (!g) {
    return {
      calories: r.per_serving.calories, protein_g: r.per_serving.protein_g,
      carbs_g: r.per_serving.carbs_g, fat_g: r.per_serving.fat_g,
      fiber_g: r.per_serving.fiber_g,
    };
  }
  const k = 100 / g;
  return {
    calories: Math.round(r.per_serving.calories * k),
    protein_g: +(r.per_serving.protein_g * k).toFixed(1),
    carbs_g: +(r.per_serving.carbs_g * k).toFixed(1),
    fat_g: +(r.per_serving.fat_g * k).toFixed(1),
    fiber_g: +(r.per_serving.fiber_g * k).toFixed(1),
  };
}
