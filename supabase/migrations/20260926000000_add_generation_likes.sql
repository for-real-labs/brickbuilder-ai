alter table public.generations
add column if not exists like_count integer not null default 0
check (like_count >= 0);

create table if not exists public.generation_likes (
  generation_id uuid not null references public.generations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (generation_id, user_id)
);

create or replace function public.sync_generation_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.generations
    set like_count = like_count + 1
    where id = new.generation_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.generations
    set like_count = greatest(like_count - 1, 0)
    where id = old.generation_id;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists generation_likes_sync_like_count on public.generation_likes;

create trigger generation_likes_sync_like_count
after insert or delete on public.generation_likes
for each row
execute function public.sync_generation_like_count();

update public.generations as g
set like_count = coalesce(l.likes, 0)
from (
  select generation_id, count(*)::integer as likes
  from public.generation_likes
  group by generation_id
) as l
where g.id = l.generation_id;

update public.generations
set like_count = 0
where like_count is distinct from 0
  and id not in (
    select generation_id
    from public.generation_likes
  );

alter table public.generation_likes enable row level security;

revoke all on public.generation_likes from anon;
revoke all on public.generation_likes from authenticated;

drop policy if exists "generation_likes_select_own" on public.generation_likes;
create policy "generation_likes_select_own"
on public.generation_likes
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "generation_likes_insert_own" on public.generation_likes;
create policy "generation_likes_insert_own"
on public.generation_likes
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "generation_likes_delete_own" on public.generation_likes;
create policy "generation_likes_delete_own"
on public.generation_likes
for delete
to authenticated
using (user_id = auth.uid());
