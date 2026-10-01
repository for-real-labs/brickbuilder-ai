-- id identifies a single saved revision; generation_id identifies the model.
alter table public.generations
  add column generation_id uuid,
  add column version integer;

-- Older manual saves recorded their parent in the prompt rather than a column.
-- Recover those explicit links first; images are only a legacy fallback for edits.
create temporary table generation_version_parents on commit drop as
select child.id, coalesce(explicit_parent.id, prompt_parent.id, image_parent.id) as parent_id
from public.generations child
left join public.generations explicit_parent
  on explicit_parent.id = child.source_generation_id
  and explicit_parent.user_id = child.user_id
  and explicit_parent.user_type = child.user_type
  and explicit_parent.id <> child.id
left join public.generations prompt_parent
  on prompt_parent.id = substring(child.prompt from
    '^(?:Updated model from |Resized model from |Edited from )([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})')::uuid
  and child.endpoint in ('updateModel', 'resizeModel', 'promptEditModel')
  and prompt_parent.user_id = child.user_id
  and prompt_parent.user_type = child.user_type
  and prompt_parent.id <> child.id
left join lateral (
  select candidate.id from public.generations candidate
  where child.endpoint in ('updateModel', 'resizeModel', 'promptEditModel')
    and child.processed_image_url is not null
    and candidate.processed_image_url = child.processed_image_url
    and candidate.user_id = child.user_id and candidate.user_type = child.user_type
    and (candidate.created_at, candidate.id) < (child.created_at, child.id)
  order by candidate.created_at desc, candidate.id desc limit 1
) image_parent on explicit_parent.id is null and prompt_parent.id is null;

update public.generations g set source_generation_id = p.parent_id
from generation_version_parents p
where g.id = p.id and g.source_generation_id is null and p.parent_id is not null;

-- Walk explicit ancestry, including image-free LLM edits and mixed edit chains.
with recursive ancestry as (
  select id, id as ancestor, array[id] as path, 0 as depth
  from public.generations
  union all
  select a.id, p.parent_id, a.path || p.parent_id, a.depth + 1
  from ancestry a join generation_version_parents p on p.id = a.ancestor
  where p.parent_id is not null and not p.parent_id = any(a.path)
), roots as (
  select distinct on (id) id, ancestor from ancestry order by id, depth desc
)
update public.generations g set generation_id = roots.ancestor
from roots where g.id = roots.id;

with numbered as (
  select id, row_number() over (
    partition by generation_id order by created_at, id
  )::integer as version from public.generations
)
update public.generations g set version = numbered.version
from numbered where g.id = numbered.id;

alter table public.generations
  alter column generation_id set not null,
  alter column version set not null,
  add constraint generations_version_positive check (version > 0),
  add constraint generations_model_version_unique unique (generation_id, version);

-- Allocate centrally so concurrent edits, including edits of old revisions,
-- receive distinct increasing versions. Failed/cancelled jobs keep their number.
create function public.assign_generation_version() returns trigger
language plpgsql set search_path = public as $$
declare
  source public.generations%rowtype;
begin
  new.generation_id := coalesce(new.generation_id, new.id);
  new.version := 1;
  if new.source_generation_id is not null then
    select * into source from public.generations where id = new.source_generation_id;
    if not found then
      raise exception 'Source generation not found';
    end if;
    if source.user_id = new.user_id and source.user_type = new.user_type then
      new.generation_id := source.generation_id;
    elsif not (coalesce(source.is_community, false) and coalesce(source.status = 'completed', false)) then
      raise exception 'Source generation belongs to another owner';
    else
      new.generation_id := new.id;
    end if;
    -- Editing another owner's published model creates an independent model.
  end if;
  -- New application code sends only model identity; retain the legacy input
  -- until the separate column-removal migration runs after deployment.
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

create trigger generations_assign_version before insert on public.generations
for each row execute function public.assign_generation_version();

create index generations_owner_model_version_idx
  on public.generations(user_id, user_type, generation_id, version desc);

-- Choose the highest version BEFORE dashboard pagination/status filtering.
-- security_invoker preserves the generations table's owner/RLS policies.
create view public.latest_generations with (security_invoker = true) as
select distinct on (user_id, user_type, generation_id) *
from public.generations
order by user_id, user_type, generation_id, version desc;

revoke all on public.latest_generations from public;
grant select on public.latest_generations to anon, authenticated, service_role;
