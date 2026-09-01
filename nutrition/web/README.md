# Nutrition Log — Phase 1

Camera-first food logging PWA. Next.js 16 + Supabase + Claude.

Design rationale lives in `../../nutrition-app-plan.md`; this file is setup only.

---

## Setup

### 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com) (free tier is ample).
2. Open **SQL Editor** and run `supabase/schema.sql` in full. It is idempotent — safe to re-run.
3. **Authentication → Providers → Email**: enable it, and leave "Confirm email" on. Sign-in is a magic link, so there is no password to manage.
4. **Project Settings → API**: copy the project URL, the `anon` key, and the `service_role` key.

### 2. Environment

```bash
cp .env.local.example .env.local
```

Fill in all four values. Two things worth repeating:

- **`ANTHROPIC_API_KEY` must come from a personal organisation, not Fabric's.** Console payment methods are org-level, and this app sends photos of your food and stores your bodyweight — that traffic must not live in a company-owned org. Your Claude subscription does not cover API usage; this is separate metered billing (~$3/month).
- **`SUPABASE_SERVICE_ROLE_KEY` has no `NEXT_PUBLIC_` prefix and must never get one.** It bypasses Row Level Security.

`NEXT_PUBLIC_*` values are inlined at build time, so the app must be rebuilt after changing them.

### 3. Verify

```bash
npm install
```

```bash
npm run preflight
```

Checks all four env values are real (not placeholders), that the anon and service-role
keys have not been swapped, that all five tables and the `photos` bucket exist, that RLS
actually blocks unauthenticated reads, and that the Anthropic key is live. Read-only and
free — the API check lists models rather than sending a message.

Run this before `dev` on a fresh setup. Every failure it catches otherwise appears as a
blank screen or a row stuck on `pending`, with the real cause three layers down.

### 4. Run

```bash
npm run dev
```

Open `http://localhost:3000`, enter your email, click the magic link.

The magic link points at `localhost:3000` by default. To use the app from your phone
before deploying, set **Authentication → URL Configuration → Site URL** to the deployed
URL, or the link will open a page your phone cannot reach.

### 5. Install on the phone

Deploy first (`vercel`), then open the deployed URL in Chrome on Android → **⋮ → Add to Home screen**. The camera and Share Target only behave correctly over HTTPS, so test on the deployed URL rather than a LAN address.

---

## What Phase 1 does

| | |
|---|---|
| Capture | Camera-first home screen. Four modes: Food, Label, Recipe, Voice. |
| Speed | The entry row is created *before* the AI call, so the log appears instantly and you can lock the phone. Supabase Realtime fills in the estimate whenever it lands. |
| Correction | Portion chips (½× 1× 1½× 2×). No gram entry, no serving dropdowns. |
| Today | Reverse-chronological list, four macro bars, protein floor marked. |
| Budget | Uneven daily allocation — 1800 Sun–Thu, 2150 Fri, 2500 Sat. |
| Trend | EWMA weight trend, adaptive TDEE, projected finish date. |

**Not in Phase 1** (see plan §8): the Again screen, barcode scanning, Open Food Facts lookup, Shabbat pre-log and reconciliation, offline queue, combo detection. Phase 2 and 2.5.

---

## Scripts

```bash
npm run dev
```

```bash
npm test
```

29 tests over the nutrition math — the budget split, the Friday-to-Friday week boundary, EWMA behaviour across Shabbat gaps, and the adaptive-TDEE bias-invariance property. Run these after touching `src/lib/nutrition.ts`; they encode the numbers from the plan, so a divergence fails loudly instead of silently changing your calorie target.

```bash
npm run build
```

---

## Things that will bite you

**Do not change `src/lib/prompts.ts` casually.** The adaptive-TDEE engine solves for expenditure from the relationship between logged intake and measured weight change, which means it absorbs a *consistent* estimation bias and cancels it out of your target. Materially changing the prompts silently redefines the unit your calorie targets are denominated in. If you must, bump `PROMPT_VERSION` and re-baseline history from the retained `entries.ai_raw` column.

**Label mode is on `claude-opus-5`, everything else on `claude-sonnet-5`.** This is deliberate — Sonnet 5 swapped the per-100g and per-container columns on a Hebrew Tnuva yogurt panel and returned every macro exactly 2× high with `medium` confidence and no flag. Label results are cached into `products` and reused forever, so that error is permanent rather than a single bad data point. Costs ~$0.15/month extra. Do not "simplify" it back to one model.

**`browserClient()` must only be called from effects and event handlers, never during render.** A `use client` page still gets a server prerender pass; constructing the client there breaks the build.

**Never import `@/lib/supabase/server` from a client component.** It holds the service-role key. The split into `client.ts` / `server.ts` exists precisely to make that mistake a build error.

---

## Phase 0 harness

`../estimate.py`, `../score.py`, `../prompts.py` — the validation runner. `src/lib/prompts.ts` is a port of `../prompts.py`; **when you change one, change both**, or the app and the validated baseline drift apart.
