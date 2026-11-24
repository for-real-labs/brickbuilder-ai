-- Return zero for invalid inventories so the table constraint rejects the write.
create function public.parts_list_piece_count(parts jsonb) returns integer
language plpgsql immutable strict set search_path = '' as $$
declare
  item jsonb;
  total integer := 0;
begin
  if jsonb_typeof(parts) <> 'array' or jsonb_array_length(parts) not between 1 and 10000 then
    return 0;
  end if;
  for item in select value from jsonb_array_elements(parts) loop
    if jsonb_typeof(item) <> 'object' or not (item ?& array['part_id','color_id','quantity'])
       or item - array['part_id','color_id','quantity'] <> '{}'::jsonb
       or jsonb_typeof(item->'part_id') <> 'string' or item->>'part_id' !~ '^[a-z0-9][a-z0-9_-]{0,79}$'
       or jsonb_typeof(item->'color_id') <> 'number' or item->>'color_id' !~ '^[0-9]{1,5}$'
       or jsonb_typeof(item->'quantity') <> 'number' or item->>'quantity' !~ '^[1-9][0-9]{0,5}$' then
      return 0;
    end if;
    if (item->>'color_id')::integer in (16,24) or (item->>'color_id')::integer > 65535 then
      return 0;
    end if;
    total := total + (item->>'quantity')::integer;
    if total > 100000 then return 0; end if;
  end loop;
  return total;
end;
$$;

revoke all on function public.parts_list_piece_count(jsonb) from public, anon;
grant execute on function public.parts_list_piece_count(jsonb) to authenticated, service_role;

create table public.saved_parts_lists (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200 and char_length(name) <= 200),
  parts jsonb not null,
  piece_count integer generated always as (public.parts_list_piece_count(parts)) stored check (piece_count > 0),
  revision integer not null default 1,
  updated_at timestamptz not null default now()
);
create index saved_parts_lists_owner_updated on public.saved_parts_lists(owner_id, updated_at desc, id);
create function public.touch_saved_parts_list() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end;
$$;
create trigger touch_saved_parts_list before update on public.saved_parts_lists
for each row execute function public.touch_saved_parts_list();

alter table public.saved_parts_lists enable row level security;
revoke all on public.saved_parts_lists from public, anon, authenticated;
grant select, insert(id,owner_id,name,parts), update(name,parts) on public.saved_parts_lists to authenticated;
create policy private_parts_lists on public.saved_parts_lists to authenticated
using (owner_id = (select auth.uid()) and (select public.account_has_mfa_assurance()))
with check (owner_id = (select auth.uid()) and (select public.account_has_mfa_assurance()));
