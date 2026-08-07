"""
Phase 0 validation runner: batch food/label/recipe photos through Claude and report
structured nutrition estimates, token cost, and latency.

The model is chosen per mode (see MODEL_BY_MODE below): claude-sonnet-5 for food, recipe
and voice; claude-opus-5 for label, where a column-swap failure on Hebrew panels makes the
cheaper model unsafe. Override with --model to A/B a mode.

The point of Phase 0 is to answer one question before any UI exists: is vision-based
estimation good enough to build on? Run this over ~15 real meals and ~5 Israeli product
labels (at least two Hebrew-only), plus a couple of Shabbat recipe cards, then use
score.py to check the numbers against your own estimates.

Usage
-----
    # one directory of meal photos
    python estimate.py --dir photos/food --mode food

    # Hebrew nutrition labels
    python estimate.py --dir photos/labels --mode label

    # recipe cards -> reusable per-serving dishes
    python estimate.py --dir photos/recipes --mode recipe

    # single image
    python estimate.py --image photos/food/cholent.jpg --mode food

    # voice / text mode (no image)
    python estimate.py --text "two eggs, two slices of whole wheat toast with butter" --mode voice

Output
------
    results/<mode>.json   machine-readable, one record per input, includes raw response
    results/<mode>.md     human-readable report for eyeballing

Setup
-----
    pip install anthropic pillow
    set ANTHROPIC_API_KEY=sk-ant-...        (cmd)
    $env:ANTHROPIC_API_KEY = "sk-ant-..."   (PowerShell)

If ANTHROPIC_API_KEY is not set but you have run `ant auth login`, the SDK picks up that
profile automatically and no env var is needed.
"""

import argparse
import base64
import io
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import anthropic
except ImportError:
    sys.exit("Missing dependency. Run:  pip install anthropic pillow")

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Missing dependency. Run:  pip install anthropic pillow")

from prompts import MODES, USER_TEXT, frequent_items_block

# --------------------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------------------

# Model is chosen per mode, not globally. Rationale from the 2026-08-06 A/B on the same
# 6 photos (results-opus5/ vs results/):
#
#   food / recipe / voice -> claude-sonnet-5
#       Recipes agreed within 2-11% of Opus 5 on totals, yield and ingredient count.
#       ~40% cheaper and roughly 2x faster, which the async capture flow benefits from.
#
#   label -> claude-opus-5
#       Sonnet 5 swapped the per-100g and per-container columns on a Hebrew Tnuva yogurt
#       panel, returning every macro exactly 2x high, inventing a serving size to fit, and
#       reporting "medium" confidence with no flag. It was exact on the other two labels.
#       That makes the error erratic rather than a consistent bias, so the adaptive-TDEE
#       engine cannot absorb it (see plan section 3.1) - and because label results are
#       cached into the products table and reused forever (plan section 5.2), one bad
#       transcription silently corrupts every future log of that product.
#       Label mode is also the lowest-volume mode, so the extra cost is ~$0.15/month.
#
# Mixing models across modes does NOT violate the bias-consistency rule in section 3.1.
# That rule applies to *estimation* (food photos), where there is a bias to keep stable.
# Label mode is transcription against printed ground truth - there is no bias, only right
# and wrong. What matters is that each mode stays on one model.
MODEL_BY_MODE = {
    "food": "claude-sonnet-5",
    "voice": "claude-sonnet-5",
    "recipe": "claude-sonnet-5",
    "label": "claude-opus-5",
}

# Downsample to this long edge before upload. claude-opus-5 accepts up to 2576 px and will
# bill roughly 4,800 tokens for a full-resolution image; a food photo needs nothing like
# that. ~1100 px is a ~4x cost reduction with no measurable accuracy loss on this task.
# See plan section 7.
MAX_EDGE = 1100
JPEG_QUALITY = 85

# Rates in USD per million tokens (plan section 7). Standard rates are used deliberately:
# Sonnet 5 introductory pricing of $2/$10 runs through 2026-08-31, so real spend comes in
# below these figures until then, and budgeting at the standard rate avoids a 1 September
# surprise. Cache read is 0.1x input, cache write 1.25x input.
PRICES = {
    "claude-opus-5":   {"in": 5.00, "out": 25.00},
    "claude-sonnet-5": {"in": 3.00, "out": 15.00},
}

# DO NOT change a mode's model once you start logging for real without re-baselining
# history from the retained entries.ai_raw responses (plan section 3.1).

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


# --------------------------------------------------------------------------------------
# Image preparation
# --------------------------------------------------------------------------------------

def prepare_image(path: Path) -> tuple[str, str, tuple[int, int]]:
    """
    Load, EXIF-rotate, downsample and base64-encode an image.

    EXIF rotation matters more than it sounds: phone photos routinely carry an orientation
    flag rather than rotated pixels, and a sideways plate measurably degrades both
    identification and portion estimation. Everything is normalised to JPEG so there is
    one media_type to reason about.

    Returns (base64_data, media_type, (width, height)).
    """
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)      # honour orientation flag
        img = img.convert("RGB")                # drop alpha; JPEG cannot carry it
        img.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        size = img.size
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)

    # standard_b64encode produces no newlines, which the API requires.
    data = base64.standard_b64encode(buf.getvalue()).decode("ascii")
    return data, "image/jpeg", size


# --------------------------------------------------------------------------------------
# API call
# --------------------------------------------------------------------------------------

def build_system(mode: str, frequent: list[str] | None) -> list[dict]:
    """
    Assemble the system prompt as cacheable blocks.

    The stable instruction block carries the cache breakpoint; volatile per-user history
    goes after it so it never invalidates the cache. claude-opus-5 has a 512-token cache
    minimum, which the instruction block clears comfortably.
    """
    blocks = [
        {
            "type": "text",
            "text": MODES[mode]["system"],
            "cache_control": {"type": "ephemeral"},
        }
    ]
    extra = frequent_items_block(frequent or [])
    if extra:
        blocks.append({"type": "text", "text": extra})
    return blocks


def estimate(client, mode: str, image_path: Path | None = None,
             text: str | None = None, frequent: list[str] | None = None,
             model: str | None = None) -> dict:
    """Run one estimation and return a result record."""
    model = model or MODEL_BY_MODE[mode]
    content = []
    dims = None

    if MODES[mode]["input"] == "image":
        if image_path is None:
            raise ValueError(f"mode '{mode}' requires an image")
        data, media_type, dims = prepare_image(image_path)
        # Image before text: the model attends to the instruction with the image already
        # in context, which is the documented ordering for vision prompts.
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        })
        content.append({"type": "text", "text": USER_TEXT[mode]})
    else:
        if not text:
            raise ValueError(f"mode '{mode}' requires --text")
        content.append({"type": "text", "text": USER_TEXT[mode].format(text=text)})

    started = time.monotonic()
    response = client.messages.create(
        model=model,
        max_tokens=4096,                       # headroom for thinking + the JSON payload
        system=build_system(mode, frequent),
        messages=[{"role": "user", "content": content}],
        output_config={
            # Thinking is on by default on claude-opus-5. "low" effort is the right
            # trade here: it improves portion reasoning at negligible cost.
            "effort": "low",
            # Structured outputs guarantee schema-valid JSON. No regex, no parse-retry loop.
            "format": {"type": "json_schema", "schema": MODES[mode]["schema"]},
        },
    )
    elapsed = time.monotonic() - started

    record = {
        "source": str(image_path) if image_path else "(text)",
        "mode": mode,
        "model": response.model,
        "stop_reason": response.stop_reason,
        "seconds": round(elapsed, 2),
        "image_px": list(dims) if dims else None,
        "usage": usage_dict(response.usage),
        "cost_usd": round(call_cost(response.usage, model), 5),
    }

    # Always check stop_reason before reading content: claude-opus-5 runs safety
    # classifiers and a declined request returns HTTP 200 with an empty content array.
    if response.stop_reason == "refusal":
        record["error"] = "refusal"
        record["data"] = None
        return record

    if response.stop_reason == "max_tokens":
        record["error"] = "truncated - raise max_tokens"
        record["data"] = None
        return record

    payload = next((b.text for b in response.content if b.type == "text"), None)
    if payload is None:
        record["error"] = "no text block in response"
        record["data"] = None
        return record

    record["data"] = json.loads(payload)       # schema-guaranteed valid
    return record


def usage_dict(usage) -> dict:
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
    }


def call_cost(usage, model: str) -> float:
    u = usage_dict(usage)
    p = PRICES[model]
    return (
        u["input_tokens"] / 1e6 * p["in"]
        + u["output_tokens"] / 1e6 * p["out"]
        + u["cache_read_input_tokens"] / 1e6 * (p["in"] * 0.1)
        + u["cache_creation_input_tokens"] / 1e6 * (p["in"] * 1.25)
    )


# --------------------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------------------

def item_totals(data: dict) -> dict:
    """Sum macros across items for food/voice mode results."""
    items = data.get("items", [])
    return {
        "calories": sum(i["calories_est"] for i in items),
        "calories_low": sum(i["calories_low"] for i in items),
        "calories_high": sum(i["calories_high"] for i in items),
        "protein_g": sum(i["protein_g"] for i in items),
        "carbs_g": sum(i["carbs_g"] for i in items),
        "fat_g": sum(i["fat_g"] for i in items),
    }


def render_report(records: list[dict], mode: str) -> str:
    models = sorted({r.get("model") or "?" for r in records})
    out = [
        f"# Phase 0 estimation report - mode: {mode}",
        "",
        f"Model: {', '.join(f'`{m}`' for m in models)}"
        f"  |  Run: {datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        "",
    ]

    ok = [r for r in records if r.get("data")]
    failed = [r for r in records if not r.get("data")]
    total_cost = sum(r["cost_usd"] for r in records)
    mean_secs = sum(r["seconds"] for r in records) / len(records) if records else 0

    out += [
        f"- Inputs: **{len(records)}**  ({len(ok)} succeeded, {len(failed)} failed)",
        f"- Total cost: **${total_cost:.4f}**  |  mean **${total_cost / max(len(records),1):.4f}** per call",
        f"- Mean latency: **{mean_secs:.1f}s**",
        "",
        "---",
        "",
    ]

    for r in records:
        out.append(f"## `{Path(r['source']).name}`")
        out.append("")
        out.append(
            f"`{r['seconds']}s` | `${r['cost_usd']}` | "
            f"in {r['usage']['input_tokens']} / out {r['usage']['output_tokens']} tok"
            + (f" | cache read {r['usage']['cache_read_input_tokens']}"
               if r["usage"]["cache_read_input_tokens"] else "")
        )
        out.append("")

        if not r.get("data"):
            out += [f"**FAILED: {r.get('error')}**", "", "---", ""]
            continue

        d = r["data"]

        if mode in ("food", "voice"):
            t = item_totals(d)
            out += [
                f"**{t['calories']:.0f} kcal** "
                f"(range {t['calories_low']:.0f}-{t['calories_high']:.0f}) | "
                f"P {t['protein_g']:.0f}g  C {t['carbs_g']:.0f}g  F {t['fat_g']:.0f}g | "
                f"confidence **{d['overall_confidence']}**",
                "",
                "| Item | Portion | g | kcal | P | C | F | Conf | Alternatives |",
                "|---|---|---|---|---|---|---|---|---|",
            ]
            for i in d["items"]:
                alts = ", ".join(i["alternatives"]) or "-"
                name = i["name"] + (f" / {i['name_he']}" if i["name_he"] else "")
                out.append(
                    f"| {name} | {i['portion_description']} | {i['portion_grams_est']:.0f} "
                    f"| {i['calories_est']:.0f} | {i['protein_g']:.0f} | {i['carbs_g']:.0f} "
                    f"| {i['fat_g']:.0f} | {i['confidence']} | {alts} |"
                )

        elif mode == "label":
            p = d["per_100g"]
            title = d["product_name"] + (f" / {d['product_name_he']}" if d["product_name_he"] else "")
            out += [
                f"**{title}**" + (f"  -  {d['brand']}" if d["brand"] else ""),
                "",
                f"Label language: {d['label_language']} | confidence **{d['confidence']}**"
                + (f" | barcode `{d['barcode']}`" if d["barcode"] else ""),
                "",
                "| Per 100 g | kcal | P | C | sugars | F | sat | fibre | Na (mg) |",
                "|---|---|---|---|---|---|---|---|---|",
                f"| | {p['calories']:.0f} | {p['protein_g']:.1f} | {p['carbs_g']:.1f} "
                f"| {p['sugars_g']:.1f} | {p['fat_g']:.1f} | {p['saturated_fat_g']:.1f} "
                f"| {p['fiber_g']:.1f} | {p['sodium_mg']:.0f} |",
                "",
                f"Serving: {d['serving_label'] or 'not stated'}"
                + (f"  ({d['serving_grams']:.0f} g)" if d["serving_grams"] else "")
                + (f", {d['servings_per_package']:.0f} per package" if d["servings_per_package"] else ""),
            ]

        elif mode == "recipe":
            ps, tot = d["per_serving"], d["totals"]
            title = d["dish_name"] + (f" / {d['dish_name_he']}" if d["dish_name_he"] else "")
            yield_note = (
                f"{d['servings_assumed']:.0f} servings (stated)"
                if d["servings_stated"]
                else f"{d['servings_assumed']:.0f} servings (**ASSUMED - confirm this**)"
            )
            out += [
                f"**{title}** - {yield_note} | confidence **{d['confidence']}**",
                "",
                f"**Per serving: {ps['calories']:.0f} kcal** | "
                f"P {ps['protein_g']:.0f}g  C {ps['carbs_g']:.0f}g  F {ps['fat_g']:.0f}g | "
                f"{ps['grams']:.0f} g",
                "",
                f"Whole dish: {tot['calories']:.0f} kcal, {tot['grams']:.0f} g",
                "",
                "| Ingredient | As written | g | g conf | kcal | P | C | F |",
                "|---|---|---|---|---|---|---|---|",
            ]
            # Sort calorie-dominant ingredients first - those are the rows worth weighing.
            for ing in sorted(d["ingredients"], key=lambda x: -x["calories"]):
                flag = " **!**" if ing["grams_confidence"] == "low" else ""
                out.append(
                    f"| {ing['name']} | {ing['quantity_as_written']} | {ing['grams_est']:.0f} "
                    f"| {ing['grams_confidence']}{flag} | {ing['calories']:.0f} "
                    f"| {ing['protein_g']:.1f} | {ing['carbs_g']:.1f} | {ing['fat_g']:.1f} |"
                )

        if d.get("notes"):
            out += ["", f"> {d['notes']}"]
        out += ["", "---", ""]

    return "\n".join(out)


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Phase 0 nutrition estimation validation runner.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--dir", help="directory of images to process")
    src.add_argument("--image", help="single image to process")
    src.add_argument("--text", help="meal description (voice mode)")
    ap.add_argument("--mode", required=True, choices=sorted(MODES), help="estimation mode")
    ap.add_argument("-o", "--out", help="output JSON path (default results/<mode>.json)")
    ap.add_argument("--frequent", help="comma-separated frequent items to inject as user history")
    ap.add_argument("--model", choices=sorted(PRICES),
                    help="override the per-mode default model (for A/B comparison)")
    args = ap.parse_args()

    model = args.model or MODEL_BY_MODE[args.mode]

    if MODES[args.mode]["input"] == "text" and not args.text:
        ap.error(f"mode '{args.mode}' needs --text")
    if MODES[args.mode]["input"] == "image" and args.text:
        ap.error(f"mode '{args.mode}' needs --dir or --image, not --text")

    # A bare Anthropic() also resolves an `ant auth login` profile, so an unset env var
    # is not necessarily an error - let the SDK try before complaining.
    client = anthropic.Anthropic()

    frequent = [s.strip() for s in args.frequent.split(",")] if args.frequent else None

    if args.text:
        inputs = [None]
    elif args.image:
        inputs = [Path(args.image)]
    else:
        d = Path(args.dir)
        if not d.is_dir():
            sys.exit(f"Not a directory: {d}")
        inputs = sorted(p for p in d.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
        if not inputs:
            sys.exit(f"No images found in {d} (looked for {sorted(IMAGE_SUFFIXES)})")

    print(f"mode={args.mode}  model={model}"
          + ("  (overridden)" if args.model else "")
          + f"  inputs={len(inputs)}\n")

    records = []
    for n, path in enumerate(inputs, 1):
        label = path.name if path else "(text input)"
        print(f"[{n}/{len(inputs)}] {label} ... ", end="", flush=True)
        try:
            rec = estimate(client, args.mode, image_path=path, text=args.text,
                           frequent=frequent, model=model)
            if rec.get("data"):
                if args.mode in ("food", "voice"):
                    print(f"{item_totals(rec['data'])['calories']:.0f} kcal  "
                          f"({rec['seconds']}s, ${rec['cost_usd']})")
                elif args.mode == "label":
                    print(f"{rec['data']['per_100g']['calories']:.0f} kcal/100g  "
                          f"({rec['seconds']}s, ${rec['cost_usd']})")
                else:
                    print(f"{rec['data']['per_serving']['calories']:.0f} kcal/serving  "
                          f"({rec['seconds']}s, ${rec['cost_usd']})")
            else:
                print(f"FAILED: {rec.get('error')}")
        except anthropic.RateLimitError:
            print("rate limited - waiting 30s and retrying once")
            time.sleep(30)
            rec = estimate(client, args.mode, image_path=path, text=args.text,
                           frequent=frequent, model=model)
        except anthropic.APIStatusError as e:
            print(f"API error {e.status_code}: {e.message}")
            rec = {"source": str(path) if path else "(text)", "mode": args.mode,
                   "error": f"{e.status_code}: {e.message}", "data": None,
                   "cost_usd": 0.0, "seconds": 0.0,
                   "usage": {"input_tokens": 0, "output_tokens": 0,
                             "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}
        records.append(rec)

    out_json = Path(args.out) if args.out else Path("results") / f"{args.mode}.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(records, indent=2, ensure_ascii=False), encoding="utf-8")

    out_md = out_json.with_suffix(".md")
    out_md.write_text(render_report(records, args.mode), encoding="utf-8")

    total = sum(r["cost_usd"] for r in records)
    print(f"\nWrote {out_json} and {out_md}")
    print(f"Total cost: ${total:.4f}  ({len(records)} calls, "
          f"${total / max(len(records), 1):.4f} each)")
    if args.mode in ("food", "voice"):
        print("\nNext: fill in truth.csv with your own kcal estimates, then run:")
        print(f"  python score.py --results {out_json} --truth truth.csv")


if __name__ == "__main__":
    main()
