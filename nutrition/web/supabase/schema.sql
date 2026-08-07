-- Nutrition log schema. Run this once in the Supabase SQL editor.
-- Safe to re-run: every statement is idempotent.
--
-- Design notes that matter (see nutrition-app-plan.md):
--   * ai_raw + ai_model are retained deliberately. The adaptive-TDEE engine (plan 3.1)
--     treats logged calories as a stable unit of measurement, so if the prompt or model
--     ever changes, history must be re-baselined rather than left as a discontinuity.
--   * logged_at is separate from created_at so Shabbat meals can be backdated to the
--     slot they were actually eaten in (plan 10.2).
--   * RLS is on every table. This is single-user today, but an unprotected table is one
--     forgotten policy away from being public.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- products: your personal food database. Grows every time you scan something.
-- ---------------------------------------------------------------------------
create table if not exists products (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users on delete cascade,  -- null = global
  barcode           text,
  name              text not null,
  name_he           text,
  brand             text,
  per_100g          jsonb not null,   -- {calories, protein_g, carbs_g, fat_g, fiber_g}
  serving_grams     numeric,
  serving_label     text,
  source            text not null
                      check (source in ('openfoodfacts','label_ocr','recipe_ocr',
                                        'recipe_manual','manual')),
  recipe_raw        jsonb,            -- ingredient table + yield, for later correction
  recipe_photo_path text,
  times_logged      integer not null default 0,
  last_logged_at    timestamptz,
  created_at        timestamptz not null default now()
);

-- One product per barcode per user. Partial index so rows without a barcode
-- (recipes, manual entries) are unconstrained.
create unique index if not exists products_barcode_uniq
  on products (coalesce(user_id::text, 'global'), barcode)
  where barcode is not null;

create index if not exists products_frequent
  on products (user_id, times_logged desc nulls last);

-- ---------------------------------------------------------------------------
-- entries: every logged eating event.
-- ---------------------------------------------------------------------------
create table if not exists entries (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users on delete cascade,
  logged_at          timestamptz not null default now(),   -- when it was EATEN
  created_at         timestamptz not null default now(),   -- when it was RECORDED
  source             text not null
                       check (source in ('photo','barcode','label','recipe',
                                         'voice','again','manual')),
  mode               text check (mode in ('food','label','recipe','voice')),
  photo_path         text,
  raw_input          text,             -- voice transcript or free text
  status             text not null default 'pending'
                       check (status in ('pending','estimated','confirmed','failed')),
  product_id         uuid references products on delete set null,
  portion_multiplier numeric not null default 1.0,

  -- Shabbat handling (plan 10.2). meal_slot lets a backdated entry land in the
  -- right meal; shabbat_plan_id groups a Friday pre-log for one-tap reconciliation.
  meal_slot          text check (meal_slot in ('friday_dinner','kiddush',
                                               'shabbat_lunch','seudah_shlishit')),
  shabbat_plan_id    uuid,
  reconciled_at      timestamptz,

  -- Provenance. Never drop these: they are what makes a re-baseline possible.
  ai_model           text,
  ai_raw             jsonb,
  confidence         text check (confidence in ('high','medium','low')),
  low_confidence     boolean not null default false,  -- set on late reconciliation

  name               text,
  calories           numeric,
  calories_low       numeric,
  calories_high      numeric,
  protein_g          numeric,
  carbs_g            numeric,
  fat_g              numeric,
  fiber_g            numeric,
  user_corrected     boolean not null default false
);

create index if not exists entries_user_logged
  on entries (user_id, logged_at desc);
create index if not exists entries_pending
  on entries (user_id, status) where status = 'pending';
create index if not exists entries_shabbat_plan
  on entries (shabbat_plan_id) where shabbat_plan_id is not null;

-- ---------------------------------------------------------------------------
-- weights: morning weigh-ins. trend_kg is the EWMA, computed in the app.
-- ---------------------------------------------------------------------------
create table if not exists weights (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  measured_on date not null,
  weight_kg   numeric not null check (weight_kg > 20 and weight_kg < 400),
  trend_kg    numeric,
  created_at  timestamptz not null default now(),
  unique (user_id, measured_on)
);

-- ---------------------------------------------------------------------------
-- tdee_snapshots: weekly adaptive-TDEE audit trail (plan 3.1).
-- week_ending is a FRIDAY, not a Sunday - Sunday readings run 1-3 lbs high on
-- Shabbat water and sodium and would pollute the calculation (plan 3.2).
-- ---------------------------------------------------------------------------
create table if not exists tdee_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users on delete cascade,
  week_ending         date not null,
  mean_intake_kcal    numeric not null,
  trend_change_kg     numeric not null,
  implied_deficit     numeric not null,
  effective_tdee      numeric not null,
  target_kcal_next_wk numeric not null,
  days_logged         integer not null,
  shabbat_late        boolean not null default false,  -- down-weight this week
  created_at          timestamptz not null default now(),
  unique (user_id, week_ending)
);

-- ---------------------------------------------------------------------------
-- combos: saved multi-item groups for one-tap logging on the Again screen.
-- ---------------------------------------------------------------------------
create table if not exists combos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  label       text not null,
  product_ids uuid[] not null,
  times_used  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table entries        enable row level security;
alter table products       enable row level security;
alter table weights        enable row level security;
alter table tdee_snapshots enable row level security;
alter table combos         enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['entries','weights','tdee_snapshots','combos'])
  loop
    execute format('drop policy if exists own_rows on %I', t);
    execute format($f$
      create policy own_rows on %I
        for all
        using (user_id = auth.uid())
        with check (user_id = auth.uid())
    $f$, t);
  end loop;
end $$;

-- products additionally allows reading shared/global rows (user_id is null),
-- which is where Open Food Facts lookups are cached for reuse.
drop policy if exists products_read on products;
create policy products_read on products
  for select using (user_id = auth.uid() or user_id is null);

drop policy if exists products_write on products;
create policy products_write on products
  for insert with check (user_id = auth.uid() or user_id is null);

drop policy if exists products_update on products;
create policy products_update on products
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists products_delete on products;
create policy products_delete on products
  for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Storage bucket for meal photos. Private; paths are prefixed with the user id
-- so the policies below can scope access by folder.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists photos_own on storage.objects;
create policy photos_own on storage.objects
  for all
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- Realtime: the UI subscribes to entries so an estimate appears the moment the
-- Claude call lands, even if the app was backgrounded (plan 4.1).
-- ---------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table entries;
exception
  when duplicate_object then null;   -- already added
end $$;
