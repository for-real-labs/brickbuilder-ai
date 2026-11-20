-- Locate candidate objects first. Joining the entire storage catalog to all
-- ordered generations for each object can time out before a batch is returned.
create or replace function public.account_deletion_files(p_user_id uuid)
returns table(bucket_id text, name text)
language sql security definer set search_path = '' as $$
 with owned_model_paths as (
   select id as artifact_id from public.generations where user_id = p_user_id::text
   union
   select generation_id from public.generations where user_id = p_user_id::text
 ), prefixes as (
   select bucket.id as bucket_id, folder.path || owned.artifact_id::text as prefix
   from owned_model_paths owned
   cross join (values ('generations'), ('generation-output')) bucket(id)
   cross join (values (''), ('generations/')) folder(path)
   where owned.artifact_id is not null
   union all
   select 'change-request-images', id::text from public.change_requests where user_id = p_user_id
 ), candidates as materialized (
   select o.bucket_id, o.name from storage.objects o where o.owner_id = p_user_id::text
   union
   select o.bucket_id, o.name from prefixes p
   join storage.objects o on o.bucket_id = p.bucket_id
     -- In the C collation [prefix/, prefix0) is exactly the prefix/ subtree.
     and o.name collate "C" >= (p.prefix || '/') collate "C"
     and o.name collate "C" < (p.prefix || '0') collate "C"
 ), identified as materialized (
   select c.bucket_id, c.name,
     case when c.bucket_id in ('generations', 'generation-output') then
       substring(c.name from '^(?:generations/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/')::uuid
     end as artifact_id
   from candidates c
 )
 select c.bucket_id, c.name from identified c
 where exists (select 1 from public.account_deletions where user_id = p_user_id)
   and not exists (
     select 1 from public.generations g
     join public.generations purchased on purchased.generation_id = coalesce(g.generation_id, g.id)
       or (purchased.generation_id is null and purchased.id = coalesce(g.generation_id, g.id))
     join public.orders ord on ord.generation_id = purchased.id
     where g.id = c.artifact_id or g.generation_id = c.artifact_id
   )
 order by c.bucket_id, c.name
 limit 500;
$$;
