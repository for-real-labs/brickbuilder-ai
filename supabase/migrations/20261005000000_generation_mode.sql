-- Persist the composer mode independently of the implementation endpoint.
alter table public.generations
  add column mode text not null default 'basic_bricks'
  constraint generations_mode_valid check (mode in ('basic_bricks', 'all_parts'));

update public.generations
set mode = case when endpoint = 'novaToBricks' then 'all_parts' else 'basic_bricks' end;

-- Non-generating revisions retain the mode of their original model.
update public.generations child
set mode = root.mode
from public.generations root
where child.generation_id = root.id
  and child.endpoint in ('updateModel', 'resizeModel', 'promptEditModel');

-- Keep deployments that predate the column writing the correct mode too.
create function public.assign_generation_mode() returns trigger
language plpgsql set search_path = public as $$
declare source_mode text;
begin
  if new.endpoint = 'novaToBricks' then
    new.mode := 'all_parts';
  elsif new.endpoint in ('updateModel', 'resizeModel', 'promptEditModel') then
    select g.mode into source_mode from public.generations g
      where g.id = new.generation_id;
    new.mode := coalesce(source_mode, new.mode, 'basic_bricks');
  else
    new.mode := 'basic_bricks';
  end if;
  return new;
end;
$$;

-- Version allocation must precede mode inheritance on legacy inserts.
create trigger generations_mode_after_version
before insert or update of endpoint, generation_id on public.generations
for each row execute function public.assign_generation_mode();

-- SELECT * views retain their original column set until they are refreshed.
create or replace view public.latest_generations with (security_invoker = true) as
select distinct on (user_id, user_type, generation_id) *
from public.generations
order by user_id, user_type, generation_id, version desc;

comment on column public.generations.mode is
  'Composer mode: basic_bricks for the standard BrickBuilder flow; all_parts for Nova.';
notify pgrst, 'reload schema';
