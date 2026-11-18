alter table public.generations add column restored_from_id uuid;

-- Restore inserts use the existing zero-credit manual edit path. After admission,
-- version allocation and email registration, keep the snapshot's model type.
create function public.finalize_generation_restore() returns trigger
language plpgsql set search_path = '' as $$
declare source public.generations%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.restored_from_id is distinct from old.restored_from_id then
      raise exception 'BB_RESTORE_FORBIDDEN';
    end if;
    return new;
  end if;
  if new.restored_from_id is null then return new; end if;
  if current_user not in ('service_role', 'postgres') or new.endpoint <> 'updateModel'
     or new.status <> 'completed' then
    raise exception 'BB_RESTORE_FORBIDDEN';
  end if;

  select * into source from public.generations g
  where g.id = new.restored_from_id and g.generation_id = new.generation_id
    and g.user_id = new.user_id and g.user_type = new.user_type
    and g.status = 'completed' and to_jsonb(g)->>'deleted_at' is null
    and (g.ldr_url is not null or to_jsonb(g)->>'mpd_url' is not null);
  if not found then raise exception 'BB_RESTORE_SOURCE_CHANGED'; end if;

  -- assign_generation_version already holds the model's advisory lock.
  if not exists (
    select 1 from public.generations g where g.generation_id = new.generation_id
      and g.user_id = new.user_id and g.user_type = new.user_type
      and g.status = 'completed' and to_jsonb(g)->>'deleted_at' is null and g.version > source.version
  ) then raise exception 'BB_RESTORE_NOT_OLDER'; end if;

  new.endpoint := source.endpoint;
  new.mode := source.mode;
  new.restored_from_id := coalesce(source.restored_from_id, source.id);
  return new;
end;
$$;

create trigger zz_generations_restore_revision before insert or update of restored_from_id on public.generations
for each row execute function public.finalize_generation_restore();
revoke all on function public.finalize_generation_restore() from public, anon, authenticated;
grant execute on function public.finalize_generation_restore() to service_role;
notify pgrst, 'reload schema';
