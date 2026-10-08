-- 衣脉 brand-finder · Supabase schema
-- Paste this entire file into: Supabase Dashboard → SQL Editor → New query → Run
--
-- SECURITY NOTE (personal single-user app):
-- RLS is enabled, but policies allow the anon key full CRUD.
-- Anyone who has the anon key (it ships in the frontend) can read/write all rows
-- and upload/delete objects in the `finds` bucket. Do not share the project URL +
-- anon key beyond your own devices. For multi-user later, switch to auth.uid() policies.

-- Extensions
create extension if not exists "pgcrypto";

-- ---------- Tables ----------
create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text,
  founded_year text,
  founder text,
  story text,
  positioning text,
  interesting text,
  price_notes text,
  tags text[] default '{}',
  cover_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.finds (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references public.brands(id) on delete set null,
  notes text,
  found_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.find_photos (
  id uuid primary key default gen_random_uuid(),
  find_id uuid not null references public.finds(id) on delete cascade,
  storage_path text not null,
  sort_order int not null default 0
);

create index if not exists finds_brand_id_idx on public.finds(brand_id);
create index if not exists find_photos_find_id_idx on public.find_photos(find_id);
create index if not exists brands_name_idx on public.brands(name);

-- updated_at helper
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists brands_set_updated_at on public.brands;
create trigger brands_set_updated_at
  before update on public.brands
  for each row execute function public.set_updated_at();

drop trigger if exists finds_set_updated_at on public.finds;
create trigger finds_set_updated_at
  before update on public.finds
  for each row execute function public.set_updated_at();

-- ---------- RLS (anon full access — personal app tradeoff) ----------
alter table public.brands enable row level security;
alter table public.finds enable row level security;
alter table public.find_photos enable row level security;

drop policy if exists brands_anon_all on public.brands;
create policy brands_anon_all on public.brands
  for all to anon, authenticated
  using (true) with check (true);

drop policy if exists finds_anon_all on public.finds;
create policy finds_anon_all on public.finds
  for all to anon, authenticated
  using (true) with check (true);

drop policy if exists find_photos_anon_all on public.find_photos;
create policy find_photos_anon_all on public.find_photos
  for all to anon, authenticated
  using (true) with check (true);

-- ---------- Storage bucket `finds` (public read) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'finds',
  'finds',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies for bucket `finds`
drop policy if exists finds_storage_select on storage.objects;
create policy finds_storage_select on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'finds');

drop policy if exists finds_storage_insert on storage.objects;
create policy finds_storage_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'finds');

drop policy if exists finds_storage_update on storage.objects;
create policy finds_storage_update on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'finds')
  with check (bucket_id = 'finds');

drop policy if exists finds_storage_delete on storage.objects;
create policy finds_storage_delete on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'finds');

-- Done. After Run succeeds, open the app; it will seed SOS if brands is empty.
