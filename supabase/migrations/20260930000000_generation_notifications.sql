-- Durable read receipts and parent links for resumable AI edits.
alter table public.generations
  add column if not exists notification_seen boolean not null default false,
  add column if not exists source_generation_id uuid references public.generations(id) on delete set null;

-- Start with new completions; existing history predates reliable read receipts.
update public.generations set notification_seen = true where status = 'completed';

create index if not exists generations_unread_owner_idx
  on public.generations(user_id, user_type, updated_at desc)
  where status = 'completed' and notification_seen = false;
create index if not exists generations_source_idx on public.generations(source_generation_id, created_at desc)
  where source_generation_id is not null;
