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
                                        'recipe_manual','manual','food_repeat')),
  recipe_raw        jsonb,            -- ingredient table + yield, for later correction
  recipe_photo_path text,
  times_logged      integer not null default 0,
  last_logged_at    timestamptz,
  created_at        timestamptz not null default now(),
  -- Soft delete, not a hard one: removes it from Again, but keeps the row so a
  -- food_repeat dish (promoted from repeat food/voice logs with no product of their
  -- own) can't silently reappear. A hard delete would set those entries' product_id
  -- back to null via the FK below, and the next Again load would just re-detect the
  -- same recurring dish and recreate it - deleting it would have undone itself.
  hidden            boolean not null default false
);

-- One product per barcode per user. Partial index so rows without a barcode
-- (recipes, manual entries) are unconstrained.
create unique index if not exists products_barcode_uniq
  on products (coalesce(user_id::text, 'global'), barcode)
  where barcode is not null;

create index if not exists products_frequent
  on products (user_id, times_logged desc nulls last);

-- 'food_repeat' added so a home-cooked dish logged repeatedly by photo/voice (which
-- never gets a product_id on its own - see api/estimate/route.ts) can be promoted into
-- a real reusable product once it recurs enough (lib/again.ts,
-- detectFrequentUnlinkedDishes). `create table if not exists` above is a no-op against
-- an already-existing table, so the check constraint needs its own explicit update to
-- actually reach a database that was set up before this value existed.
alter table products drop constraint if exists products_source_check;
alter table products add constraint products_source_check
  check (source in ('openfoodfacts','label_ocr','recipe_ocr',
                     'recipe_manual','manual','food_repeat'));

-- Same reasoning as above: `add column if not exists` reaches an existing table fine
-- on its own (unlike a check constraint), but the column still needs to exist here for
-- a fresh install and there for one that predates it. "Delete" on the product edit
-- screen sets this rather than removing the row - see the migration comment on the
-- column definition above for why.
alter table products add column if not exists hidden boolean not null default false;

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
-- weight_log: a separate, deliberately unconstrained personal weight diary.
--
-- Not the same table as `weights` above: that one is a single Friday-anchored daily
-- reading that drives the adaptive-TDEE engine, so it enforces one row per day. This one
-- exists purely so the user has somewhere to jot down a weight with a date and a rough
-- time of day - morning / afternoon / evening, not a timestamp - and get it back out
-- again. Multiple entries per day, no upsert, no computation, no bias correction. The
-- entire feature request was "just want a place to store it"; adding logic here that
-- wasn't asked for is exactly the over-engineering the app's own design principles warn
-- against elsewhere in this schema.
-- ---------------------------------------------------------------------------
create table if not exists weight_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  measured_on date not null,
  time_of_day text not null check (time_of_day in ('morning', 'afternoon', 'evening')),
  weight_kg   numeric not null check (weight_kg > 20 and weight_kg < 400),
  created_at  timestamptz not null default now()
);

create index if not exists weight_log_user_date
  on weight_log (user_id, measured_on desc, created_at desc);

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
-- settings: one row per user for knobs that don't belong hardcoded in nutrition.ts.
-- geonameid drives the Hebcal lookup (plan 10.2) - it defaults to Tel Aviv (293397)
-- and MUST be corrected if the user is not there, or every zmanim time is wrong.
-- ---------------------------------------------------------------------------
create table if not exists settings (
  user_id     uuid primary key references auth.users on delete cascade,
  geonameid   integer not null default 293397,
  timezone    text not null default 'Asia/Jerusalem',
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- shabbat_plans: one row per Friday-to-Saturday window (plan 10.2). Cached zmanim
-- live here so the cron job (server-side, no browser) can read them without hitting
-- Hebcal on every tick, and so the notification columns can record what has already
-- fired - the re-fire/fallback schedule needs to know what it already sent.
-- ---------------------------------------------------------------------------
create table if not exists shabbat_plans (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users on delete cascade,
  week_start            date not null,             -- the Friday
  candle_lighting       timestamptz,
  havdalah              timestamptz,
  is_yomtov             boolean not null default false,
  reconciled_at         timestamptz,
  notified_prep_at      timestamptz,                -- ~3h before candle lighting
  notified_recon_1_at   timestamptz,                -- havdalah + 30 min
  notified_recon_2_at   timestamptz,                -- +2h re-fire
  notified_recon_3_at   timestamptz,                -- Sunday 8am hard fallback
  created_at            timestamptz not null default now(),
  unique (user_id, week_start)
);

-- entries.shabbat_plan_id has existed since Phase 1 as a bare uuid (the table it
-- points to didn't exist yet). Give it a real foreign key now that shabbat_plans does.
do $$
begin
  alter table entries
    add constraint entries_shabbat_plan_fk
    foreign key (shabbat_plan_id) references shabbat_plans (id) on delete set null;
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- push_subscriptions: Web Push endpoints. Havdalah reconciliation and the Friday
-- prep nudge must reach you even if the app isn't open - that requires a real
-- push subscription, not a client-side setTimeout, since Shabbat is exactly when
-- the phone may not have the app running.
-- ---------------------------------------------------------------------------
create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now(),
  unique (user_id, endpoint)
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table entries           enable row level security;
alter table products          enable row level security;
alter table weights           enable row level security;
alter table weight_log        enable row level security;
alter table tdee_snapshots    enable row level security;
alter table combos            enable row level security;
alter table settings          enable row level security;
alter table shabbat_plans     enable row level security;
alter table push_subscriptions enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['entries','weights','weight_log','tdee_snapshots','combos',
                               'settings','shabbat_plans','push_subscriptions'])
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
