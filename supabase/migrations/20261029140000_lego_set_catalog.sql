-- Public source data, served through bounded backend queries. No client writes.
create table if not exists public.lego_set_catalog (
    set_num text primary key,
    name text not null,
    year integer not null,
    num_parts integer not null check (num_parts >= 0),
    inventory jsonb not null check (jsonb_typeof(inventory) = 'array'),
    search_text text not null,
    imported_at timestamptz not null,
    source_url text not null default 'https://rebrickable.com/downloads/'
);
create extension if not exists pg_trgm with schema extensions;
create index if not exists lego_set_catalog_search_idx
    on public.lego_set_catalog using gin (search_text extensions.gin_trgm_ops);
alter table public.lego_set_catalog enable row level security;
revoke all on public.lego_set_catalog from anon, authenticated;
grant all on public.lego_set_catalog to service_role;
comment on table public.lego_set_catalog is 'Official LEGO set inventories from Rebrickable downloads, excluding spare parts; nested sets and minifigures expanded. See docs/existing-parts.md for source attribution.';
-- Keep the original inventory available even after a Nova session is lost.
alter table public.generations add column if not exists has_parts_inventory boolean not null default false;
