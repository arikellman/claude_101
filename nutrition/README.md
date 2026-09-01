# Phase 0 — Estimation Validation

Answers one question before any UI exists: **is vision-based nutrition estimation good enough to build the app on?**

Budget: one evening. Cost: about $0.50 in API calls.

---

## Billing: the subscription does not cover this

**A Claude Pro/Max subscription and the Anthropic API are separate billing systems.** The subscription covers claude.ai and Claude Code. It cannot authenticate a script or a server route — those need an API key with its own metered credits from [console.anthropic.com](https://console.anthropic.com). `ant auth login` is not a bridge; it issues an OAuth token against an API organization and still draws on API credits.

Cost is small, and these figures are **measured** from a real 7-call run on `claude-sonnet-5`: **$0.019 per call, ~$2.80/month at 150 calls, ~$14 for the whole 21-week run.** Credits start at a $5 minimum purchase.

Recipe mode is the expensive one (~$0.042/call — long ingredient-table output), but it is a one-time cost per dish.

### Use a personal organization, not Fabric's

Console payment methods are **organization-level** — workspaces scope keys and spend limits but do not carry separate cards, so a personal card on Fabric's org would cover everyone's API spend, and a Fabric key would put this app's traffic in a company-owned org.

That second point is the real issue: this app sends photos of your food and stores your bodyweight. That data should not pass through Fabric's vendor account regardless of who pays.

So: sign up at [console.anthropic.com](https://console.anthropic.com) with a **personal email** (use a private window if already logged in as `@getfabric.com`), add a personal card to that new org, and generate the key there. Name it `nutrition-app-personal`.

⚠️ If you are signed into the Console with the Fabric account, the org switcher makes it easy to create a key in the wrong org without noticing. Confirm the selected org before generating.

### Two ways to run Phase 0

**Option A — API (recommended, tests the real code path).** Set up below. This is also the only option for Phase 1 onward, since a deployed app makes programmatic calls that a subscription cannot authenticate.

**Option B — Claude Code (free on your existing subscription).** Claude Code reads images natively, so you can skip the script for validation: drop photos in `photos/food/`, open a session in this directory, and ask Claude to analyse them against the prompts in `prompts.py` and write the same report format. Fine for a 20-photo validation run. What it does *not* do: enforce the JSON schema, exercise the production request shape, or run repeatably. Use it to answer "is the estimation good enough?" without setting up billing first, then switch to Option A for Phase 1.

## Setup (Option A)

```bash
pip install anthropic pillow
```

Then set your API key (cmd — `pip` and `npm` both want cmd rather than PowerShell on this machine):

```bash
set ANTHROPIC_API_KEY=sk-ant-...
```

Or in PowerShell:

```bash
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

---

## Step 1 — Collect the test set

Create these folders and fill them over 2–3 normal days. Do not curate for easy cases; the whole point is to find the failure modes.

```
nutrition-phase0/
  photos/
    food/      15 meals you would actually eat
    labels/    5 Israeli product labels, at least 2 Hebrew-only
    recipes/   2-3 recipe cards, ideally cholent and a kugel
```

**What to include in `food/`** — the mix matters more than the count:

| Include | Why |
|---|---|
| 3–4 home-cooked dinners | your baseline case |
| 2 restaurant meals | hidden oil, unknown portions — the hard case |
| 1 cholent or chamin | dense, mixed, calorie-heavy; the worst case in your diet |
| 1 kugel or challah plate | starch-dominant, hard to portion |
| 2 breakfasts | easy cases, to check it isn't over-estimating |
| 1 plate with no scale reference | to see whether it correctly widens its range |
| 1 half-eaten plate | tests portion reasoning rather than dish recognition |

**Shoot consistently.** Roughly 45° angle, whole plate in frame, a fork or your hand visible for scale. Consistency of framing feeds directly into consistency of estimation error, which per §3.1 of the plan is the thing that actually matters.

---

## Step 2 — Run the estimator

```bash
python estimate.py --dir photos/food --mode food
```

```bash
python estimate.py --dir photos/labels --mode label
```

```bash
python estimate.py --dir photos/recipes --mode recipe
```

Optionally test voice mode, which needs no photo:

```bash
python estimate.py --text "two eggs, two slices of whole wheat toast with butter, black coffee" --mode voice
```

Each run writes `results/<mode>.json` (machine-readable, retains the full response) and `results/<mode>.md` (readable report). Open the `.md` files and read them — that eyeball pass is half the value of Phase 0.

---

## Step 3 — Score it

Create `truth.csv` with your own honest estimate for each meal. Do this **after** running the estimator but **without reading its output first** — anchoring on the AI number invalidates the comparison.

```csv
filename,my_kcal,id_correct,notes
cholent.jpg,650,y,"got the kishke, missed the barley"
shakshuka.jpg,420,y,
salmon_dinner.jpg,700,n,"called it tuna"
```

Then:

```bash
python score.py --results results/food.json --truth truth.csv
```

---

## The decision gate

| Check | Threshold |
|---|---|
| Identification correct | ≥ 80% |
| Calories within ±25% | ≥ 70% of meals |
| **Bias standard deviation** | **≤ 20%** |

**The third one is the real test, and it is not the obvious one.** The adaptive TDEE engine (plan §3.1) does not need accurate estimates — it backs your true expenditure out of logged intake versus measured weight change, so a model that runs reliably 15% low is entirely usable. What it cannot absorb is *erratic* error: 5% high on one meal and 40% low on the next.

So read the standard deviation before the mean. A large consistent bias is a pass. A small erratic one is a fail.

`score.py` also reports **confidence calibration** — whether the model's own low-confidence flags actually predict larger errors. If they don't, skip the amber-dot confidence UI in plan §4.2, because it would be surfacing noise.

### If it fails

In order of leverage, and note that prompt editing is *last*:

1. Add a scale reference to every photo (fork, hand, standard plate)
2. Shoot from a consistent angle with the whole plate visible
3. Pass `--frequent "cholent,potato kugel,grilled chicken,israeli salad"` so portions resolve against your usual versions
4. Re-shoot and re-run
5. Only then extend the regional context block in `prompts.py` with dishes it actually missed

---

## Files

| File | Role |
|---|---|
| `prompts.py` | System prompts + JSON schemas for all four modes. **The transferable asset** — ports directly into the Phase 1 `/api/estimate` route. |
| `estimate.py` | Batch runner. EXIF-corrects and downsamples to 1100px, calls `claude-opus-5` with structured outputs, reports token cost and latency per call. |
| `score.py` | Decision gate. Error stats, bias consistency, confidence calibration, verdict. |

---

## One warning that outlives Phase 0

Once you start logging for real, **do not materially change these prompts or switch models** without re-baselining. The adaptive TDEE engine treats your logged calories as a stable unit of measurement; changing the estimator mid-run silently changes that unit, and your calorie targets go wrong in a way that is very hard to notice.

The `entries.ai_raw` and `entries.ai_model` columns in the Phase 1 schema exist for exactly this: they let you re-run history through a new prompt and get a consistent re-baseline rather than a discontinuity.
