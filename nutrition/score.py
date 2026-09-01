"""
Phase 0 decision gate: compare AI estimates against your own manual estimates and decide
whether the estimation quality justifies building the app.

The gate (plan section 8, Phase 0):
    - identification correct on >= 80% of items
    - calorie estimates within +/- 25% of your own estimate on >= 70% of meals
    - and, crucially, BIAS CONSISTENCY - see below

Why bias consistency is the real test
-------------------------------------
The adaptive-TDEE engine (plan section 3.1) does not need accurate estimates. It needs
estimates whose error is *stable*, because it backs your true expenditure out of the
relationship between logged intake and measured weight change. A model that is reliably
15% low is completely usable. A model that is 5% high on one meal and 40% low on the next
is not, no matter how good its average looks.

So the headline number here is not mean error - it is the standard deviation of the
percentage error. Read that first.

Usage
-----
    python score.py --results results/food.json --truth truth.csv

truth.csv format (create it after running estimate.py; one row per image):

    filename,my_kcal,id_correct,notes
    cholent.jpg,650,y,"got the kishke, missed the barley"
    shakshuka.jpg,420,y,
    salmon_dinner.jpg,700,n,"called it tuna"

    my_kcal     - your own best estimate of the meal's calories
    id_correct  - y/n, did it identify the foods correctly
    notes       - free text, ignored by scoring
"""

import argparse
import csv
import json
import statistics
import sys
from pathlib import Path


def load_results(path: Path) -> dict[str, dict]:
    records = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for r in records:
        if not r.get("data"):
            continue
        name = Path(r["source"]).name
        items = r["data"].get("items")
        if items is None:
            sys.exit("score.py only scores food/voice mode results (needs an 'items' array).")
        out[name] = {
            "kcal": sum(i["calories_est"] for i in items),
            "kcal_low": sum(i["calories_low"] for i in items),
            "kcal_high": sum(i["calories_high"] for i in items),
            "protein": sum(i["protein_g"] for i in items),
            "confidence": r["data"]["overall_confidence"],
        }
    return out


def load_truth(path: Path) -> dict[str, dict]:
    out = {}
    with path.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            fn = (row.get("filename") or "").strip()
            if not fn:
                continue
            raw = (row.get("my_kcal") or "").strip()
            if not raw:
                continue
            out[fn] = {
                "kcal": float(raw),
                "id_correct": (row.get("id_correct") or "").strip().lower().startswith("y"),
            }
    return out


def main():
    ap = argparse.ArgumentParser(description="Score Phase 0 estimates against manual truth.")
    ap.add_argument("--results", required=True, help="results JSON from estimate.py")
    ap.add_argument("--truth", required=True, help="truth CSV with your own estimates")
    args = ap.parse_args()

    results = load_results(Path(args.results))
    truth = load_truth(Path(args.truth))

    paired = sorted(set(results) & set(truth))
    if not paired:
        sys.exit("No filenames matched between results and truth. Check the filename column.")

    missing = sorted(set(results) - set(truth))
    if missing:
        print(f"Note: {len(missing)} result(s) have no truth row and were skipped: "
              f"{', '.join(missing[:5])}{' ...' if len(missing) > 5 else ''}\n")

    rows = []
    for name in paired:
        ai, mine = results[name]["kcal"], truth[name]["kcal"]
        pct = (ai - mine) / mine * 100 if mine else 0.0
        rows.append({
            "name": name,
            "ai": ai,
            "mine": mine,
            "pct": pct,
            "within25": abs(pct) <= 25,
            "in_range": results[name]["kcal_low"] <= mine <= results[name]["kcal_high"],
            "range_width_pct": (results[name]["kcal_high"] - results[name]["kcal_low"]) / ai * 100 if ai else 0,
            "id_correct": truth[name]["id_correct"],
            "confidence": results[name]["confidence"],
        })

    pcts = [r["pct"] for r in rows]
    n = len(rows)

    mean_bias = statistics.mean(pcts)
    stdev_bias = statistics.stdev(pcts) if n > 1 else 0.0
    mape = statistics.mean(abs(p) for p in pcts)
    within25 = sum(r["within25"] for r in rows) / n * 100
    in_range = sum(r["in_range"] for r in rows) / n * 100
    id_rate = sum(r["id_correct"] for r in rows) / n * 100
    mean_width = statistics.mean(r["range_width_pct"] for r in rows)

    print("=" * 74)
    print(f"PHASE 0 SCORING   ({n} meals)")
    print("=" * 74)
    print()
    print("Per-meal detail")
    print("-" * 74)
    print(f"{'meal':<28} {'AI':>7} {'mine':>7} {'err%':>8} {'<=25%':>6} {'inrng':>6} {'id':>4}")
    for r in sorted(rows, key=lambda x: x["pct"]):
        print(f"{r['name'][:28]:<28} {r['ai']:>7.0f} {r['mine']:>7.0f} "
              f"{r['pct']:>+8.1f} {'y' if r['within25'] else '.':>6} "
              f"{'y' if r['in_range'] else '.':>6} {'y' if r['id_correct'] else 'N':>4}")
    print()

    print("Headline metrics")
    print("-" * 74)
    print(f"  Mean bias                    {mean_bias:>+7.1f}%   "
          f"(direction and size of systematic error)")
    print(f"  Bias std deviation           {stdev_bias:>7.1f}%   "
          f"<-- THE NUMBER THAT MATTERS")
    print(f"  Mean absolute error (MAPE)   {mape:>7.1f}%")
    print(f"  Within +/-25%                {within25:>7.0f}%")
    print(f"  Your estimate inside AI range{in_range:>7.0f}%")
    print(f"  Mean AI range width          {mean_width:>7.0f}%   "
          f"(of the point estimate)")
    print(f"  Identification correct       {id_rate:>7.0f}%")
    print()

    # ---------------------------------------------------------------------------------
    # Verdict
    # ---------------------------------------------------------------------------------
    print("Verdict")
    print("-" * 74)

    checks = [
        ("Identification >= 80%", id_rate >= 80),
        ("Within +/-25% on >= 70% of meals", within25 >= 70),
        ("Bias std deviation <= 20%", stdev_bias <= 20),
    ]
    for label, ok in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}]  {label}")
    print()

    if all(ok for _, ok in checks):
        print("  BUILD. Estimation quality is sufficient.")
        if abs(mean_bias) > 10:
            print(f"  Note: a consistent {mean_bias:+.0f}% bias is present. Do NOT try to")
            print("  correct it in the prompt - the adaptive TDEE engine absorbs it, and")
            print("  'fixing' it later would break the consistency it depends on.")
    elif not checks[2][1]:
        print("  DO NOT BUILD YET. Bias is too erratic for adaptive TDEE to absorb.")
        print("  This is the one failure that cannot be worked around downstream.")
        print("  Fixes, in order of leverage:")
        print("    1. Always include a scale reference (fork, hand, standard plate) in frame.")
        print("    2. Photograph from a consistent angle - roughly 45 degrees, whole plate visible.")
        print("    3. Populate --frequent with your usual meals so portions resolve consistently.")
        print("    4. Then re-shoot and re-run before touching the prompt.")
    elif not checks[0][1]:
        print("  PROMPT WORK NEEDED. Identification is the weak link, not portioning.")
        print("  Look at which items failed: if they are Israeli/Hebrew-specific, extend the")
        print("  regional context block in prompts.py with the dishes it missed.")
    else:
        print("  MARGINAL. Portion accuracy is the weak link.")
        print("  Try the scale-reference and consistent-angle fixes above, then re-run.")
        print("  If bias std deviation is good, this is still workable - the TDEE engine")
        print("  cares far more about consistency than about absolute accuracy.")
    print()

    # Confidence calibration: does the model know when it is wrong? If low-confidence
    # results are not meaningfully worse than high-confidence ones, the amber-dot UI in
    # plan section 4.2 is pointing at noise and should not be built.
    by_conf = {}
    for r in rows:
        by_conf.setdefault(r["confidence"], []).append(abs(r["pct"]))
    if len(by_conf) > 1:
        print("Confidence calibration")
        print("-" * 74)
        for conf in ("high", "medium", "low"):
            if conf in by_conf:
                vals = by_conf[conf]
                print(f"  {conf:<8} n={len(vals):<3} mean abs error {statistics.mean(vals):>5.1f}%")
        order = [statistics.mean(by_conf[c]) for c in ("high", "medium", "low") if c in by_conf]
        if order == sorted(order):
            print("  Calibrated: error rises as confidence falls. Build the confidence flag UI.")
        else:
            print("  Not calibrated: confidence does not predict error. Skip the confidence")
            print("  flag UI for now - it would be surfacing noise.")
        print()


if __name__ == "__main__":
    main()
