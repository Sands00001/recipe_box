-- Recipe Box: initial schema
-- Mirrors the drawings app's conventions (auth.users, RLS-per-user, public storage bucket)

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;    -- fuzzy ingredient-name matching for pantry search

-- ---------------------------------------------------------------------------
-- recipes
-- ---------------------------------------------------------------------------
create table if not exists recipes (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title                   text not null,
  source                  text not null default 'other'
                          check (source in ('gousto','handwritten','book','magazine','website','other')),
  diet                    text not null default 'none'
                          check (diet in ('none','vegetarian','vegan')),
  servings                numeric,
  prep_time_minutes       integer,
  cook_time_minutes       integer,
  oven_temp_c             integer,
  oven_temp_f             integer,
  oven_gas_mark           integer,
  instructions            text,
  notes                   text,
  preferred_unit_system   text not null default 'metric'
                          check (preferred_unit_system in ('metric','imperial','us_cups')),
  image_url               text,           -- cropped/display photo (public storage URL)
  original_image_url      text,           -- uncropped source photo/scan
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists recipes_user_id_idx on recipes(user_id);

-- ---------------------------------------------------------------------------
-- recipe_tags  (meal_type + main_ingredient, many-to-many so a recipe can be
-- tagged e.g. main_ingredient=chicken AND main_ingredient=rice)
-- ---------------------------------------------------------------------------
create table if not exists recipe_tags (
  id          uuid primary key default gen_random_uuid(),
  recipe_id   uuid not null references recipes(id) on delete cascade,
  tag_type    text not null check (tag_type in ('meal_type','main_ingredient')),
  tag_value   text not null,
  unique (recipe_id, tag_type, tag_value)
);

create index if not exists recipe_tags_recipe_id_idx on recipe_tags(recipe_id);
create index if not exists recipe_tags_lookup_idx on recipe_tags(tag_type, tag_value);

-- ---------------------------------------------------------------------------
-- ingredients — original entry plus pre-computed conversions in all 3 systems
-- ---------------------------------------------------------------------------
create table if not exists ingredients (
  id                  uuid primary key default gen_random_uuid(),
  recipe_id           uuid not null references recipes(id) on delete cascade,
  sort_order          integer not null default 0,
  name                text not null,
  notes               text,                 -- e.g. "sifted", "room temperature"

  original_quantity   numeric,
  original_unit       text,
  original_system     text check (original_system in ('metric','imperial','us_cups')),

  metric_quantity     numeric,
  metric_unit         text,
  imperial_quantity   numeric,
  imperial_unit       text,
  us_cups_quantity    numeric,
  us_cups_unit        text
);

create index if not exists ingredients_recipe_id_idx on ingredients(recipe_id);
create index if not exists ingredients_name_trgm_idx on ingredients using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- ingredient_density_reference — g per US cup, used so cup<->gram conversion
-- is sensible (volume-to-weight needs a density, not a fixed factor).
-- Shared reference data, not per-user.
-- ---------------------------------------------------------------------------
create table if not exists ingredient_density_reference (
  ingredient_name     text primary key,
  grams_per_us_cup    numeric not null
);

insert into ingredient_density_reference (ingredient_name, grams_per_us_cup) values
  ('flour, plain',            125),
  ('flour, self-raising',     125),
  ('flour, bread',            130),
  ('sugar, caster',           200),
  ('sugar, granulated',       200),
  ('sugar, brown (packed)',   220),
  ('sugar, icing/powdered',   120),
  ('butter',                  227),
  ('rice, uncooked',          185),
  ('oats, rolled',            90),
  ('milk',                    245),
  ('water',                   237),
  ('honey',                   340),
  ('cocoa powder',            85),
  ('breadcrumbs',             108),
  ('parmesan, grated',        100),
  ('cheese, grated',          113)
on conflict (ingredient_name) do nothing;

-- ---------------------------------------------------------------------------
-- pantry_items — "what I have in the house" for the recipe-finder feature
-- ---------------------------------------------------------------------------
create table if not exists pantry_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name        text not null,
  quantity    numeric,
  unit        text,
  updated_at  timestamptz not null default now()
);

create index if not exists pantry_items_user_id_idx on pantry_items(user_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists recipes_set_updated_at on recipes;
create trigger recipes_set_updated_at
  before update on recipes
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — each user only sees/edits their own rows
-- ---------------------------------------------------------------------------
alter table recipes enable row level security;
alter table recipe_tags enable row level security;
alter table ingredients enable row level security;
alter table pantry_items enable row level security;
alter table ingredient_density_reference enable row level security;

create policy "recipes: owner full access" on recipes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "recipe_tags: owner full access" on recipe_tags
  for all using (exists (select 1 from recipes r where r.id = recipe_id and r.user_id = auth.uid()))
  with check (exists (select 1 from recipes r where r.id = recipe_id and r.user_id = auth.uid()));

create policy "ingredients: owner full access" on ingredients
  for all using (exists (select 1 from recipes r where r.id = recipe_id and r.user_id = auth.uid()))
  with check (exists (select 1 from recipes r where r.id = recipe_id and r.user_id = auth.uid()));

create policy "pantry_items: owner full access" on pantry_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- shared reference table: any authenticated user can read, no one edits via the app
create policy "density reference: read for authenticated" on ingredient_density_reference
  for select using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- Pantry-match search: rank recipes by how many of their ingredients are
-- covered by what's currently in the user's pantry (fuzzy name match).
-- ---------------------------------------------------------------------------
create or replace function match_recipes_by_pantry(p_user_id uuid, p_min_similarity numeric default 0.35)
returns table (
  recipe_id uuid,
  title text,
  total_ingredients integer,
  matched_ingredients integer,
  match_ratio numeric
) language sql stable as $$
  with recipe_ing as (
    select i.recipe_id, i.id as ingredient_id, i.name
    from ingredients i
    join recipes r on r.id = i.recipe_id
    where r.user_id = p_user_id
  ),
  matches as (
    select ri.recipe_id, ri.ingredient_id,
           exists (
             select 1 from pantry_items p
             where p.user_id = p_user_id
               and similarity(p.name, ri.name) >= p_min_similarity
           ) as is_matched
    from recipe_ing ri
  )
  select
    r.id as recipe_id,
    r.title,
    count(m.ingredient_id)::int as total_ingredients,
    count(m.ingredient_id) filter (where m.is_matched)::int as matched_ingredients,
    round(
      (count(m.ingredient_id) filter (where m.is_matched))::numeric
      / nullif(count(m.ingredient_id), 0), 3
    ) as match_ratio
  from recipes r
  join matches m on m.recipe_id = r.id
  where r.user_id = p_user_id
  group by r.id, r.title
  order by match_ratio desc nulls last, total_ingredients asc;
$$;

-- ---------------------------------------------------------------------------
-- Storage bucket for recipe photos (public read, like the drawings app's
-- "photos" bucket). Bucket creation itself is done via the Supabase
-- dashboard/API, not SQL — see README.
-- ---------------------------------------------------------------------------
