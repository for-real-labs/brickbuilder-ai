alter table public.generations add column deleted_at timestamptz;
alter table public.generations add constraint deleted_generations_are_private
  check (deleted_at is null or not coalesce(is_community, false));

-- Deleted versions keep their IDs and order references, but disappear from
-- direct client reads and writes as well as the dashboard and public model API.
create policy generations_visible_revisions on public.generations as restrictive
  for all to anon, authenticated using (deleted_at is null) with check (deleted_at is null);

create or replace view public.latest_generations with (security_invoker = true) as
select distinct on (user_id, user_type, generation_id) *
from public.generations where deleted_at is null
order by user_id, user_type, generation_id, version desc;

create or replace function public.assign_generation_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.generation_id := coalesce(new.generation_id, new.id);
  new.version := 1;
  if new.generation_id <> new.id then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.generation_id::text, 0));
    if not exists (
      select 1 from public.generations g where g.generation_id = new.generation_id
        and g.user_id = new.user_id and g.user_type = new.user_type and g.deleted_at is null
    ) then raise exception 'Model not found for this owner'; end if;
    select coalesce(max(g.version), 0) + 1 into new.version
    from public.generations g where g.generation_id = new.generation_id;
  end if;
  return new;
end;
$$;

create function public.delete_generation_revision(p_id uuid, p_owner text, p_type text, p_whole_model boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare model_id uuid; next_id uuid;
begin
  select g.generation_id into model_id from public.generations g
  where g.id = p_id and g.user_id = p_owner and g.user_type = p_type;
  if not found then raise exception 'BB_DELETE_NOT_FOUND'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(model_id::text, 0));
  -- Lock affected rows before checking status and ownership so a claim or job
  -- completion cannot change what this operation is allowed to delete.
  perform 1 from public.generations g where g.generation_id = model_id
    and g.user_id = p_owner and g.user_type = p_type for update;
  if not exists (select 1 from public.generations g where g.id = p_id
    and g.user_id = p_owner and g.user_type = p_type) then
    raise exception 'BB_DELETE_NOT_FOUND';
  end if;

  if exists (select 1 from public.generations g where g.generation_id = model_id
    and g.user_id = p_owner and g.user_type = p_type and g.deleted_at is null
    and (p_whole_model or g.id = p_id) and g.status not in ('completed', 'failed', 'cancelled')) then
    raise exception 'BB_DELETE_ACTIVE';
  end if;

  update public.generations g set deleted_at = now(), is_community = false, notification_seen = true
  where g.generation_id = model_id and g.user_id = p_owner and g.user_type = p_type
    and g.deleted_at is null and (p_whole_model or g.id = p_id);

  select g.id into next_id from public.generations g where g.generation_id = model_id
    and g.user_id = p_owner and g.user_type = p_type and g.deleted_at is null and g.status = 'completed'
    order by g.version desc limit 1;
  return jsonb_build_object('next_generation_id', next_id);
end;
$$;

revoke all on function public.delete_generation_revision(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.delete_generation_revision(uuid, text, text, boolean) to service_role;
notify pgrst, 'reload schema';
