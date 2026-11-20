-- A fork owns its version sequence. Only its first row records the exact version it used.
alter table public.generations add column forked_from_id uuid;

-- Older manual, resize, and image edits recorded the source in server-generated prompts.
-- AI edits that stored only the user's prompt have no reliable link to backfill.
update public.generations fork set forked_from_id = source.id
from public.generations source
where fork.id = fork.generation_id and source.status = 'completed'
  and (source.user_id, source.user_type) is distinct from (fork.user_id, fork.user_type)
  and source.id = case fork.endpoint
    when 'updateModel' then substring(fork.prompt from '^Updated model from ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')::uuid
    when 'resizeModel' then substring(fork.prompt from '^Resized model from ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')::uuid
    when 'promptEditModel' then substring(fork.prompt from '^Edited from ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):')::uuid
  end;

create function public.guard_generation_fork_source() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.forked_from_id is distinct from old.forked_from_id then
      raise exception 'BB_FORK_SOURCE_FORBIDDEN';
    end if;
  elsif new.forked_from_id is not null then
    if current_user not in ('service_role', 'postgres') or new.id <> new.generation_id
      or not exists (select 1 from public.generations source
        where source.id = new.forked_from_id and source.status = 'completed' and source.deleted_at is null
          and (source.user_id, source.user_type) is distinct from (new.user_id, new.user_type))
    then
      raise exception 'BB_FORK_SOURCE_FORBIDDEN';
    end if;
  end if;
  return new;
end;
$$;

create trigger zz_generations_fork_source before insert or update of forked_from_id on public.generations
for each row execute function public.guard_generation_fork_source();
revoke all on function public.guard_generation_fork_source() from public, anon, authenticated;
grant execute on function public.guard_generation_fork_source() to service_role;
notify pgrst, 'reload schema';
