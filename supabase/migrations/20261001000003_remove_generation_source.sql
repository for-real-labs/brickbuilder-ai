-- Requires the deployed application to use generation_id/version for edits,
-- history, notifications, and cancellation before removing the legacy parent.
create or replace function public.assign_generation_version() returns trigger
language plpgsql set search_path = public as $$
begin
  new.generation_id := coalesce(new.generation_id, new.id);
  new.version := 1;
  if new.generation_id <> new.id then
    perform pg_advisory_xact_lock(hashtextextended(new.generation_id::text, 0));
    if not exists (
      select 1 from public.generations g where g.generation_id = new.generation_id
        and g.user_id = new.user_id and g.user_type = new.user_type
    ) then
      raise exception 'Model not found for this owner';
    end if;
    select coalesce(max(g.version), 0) + 1 into new.version
    from public.generations g where g.generation_id = new.generation_id;
  end if;
  return new;
end;
$$;

-- A SELECT * view retains column dependencies, so rebuild it without the parent.
drop view public.latest_generations;
alter table public.generations drop column source_generation_id;
create view public.latest_generations with (security_invoker = true) as
select distinct on (user_id, user_type, generation_id) *
from public.generations
order by user_id, user_type, generation_id, version desc;
revoke all on public.latest_generations from public;
grant select on public.latest_generations to anon, authenticated, service_role;
