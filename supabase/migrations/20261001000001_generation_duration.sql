-- Record the first successful build's wall-clock duration at the same moment
-- its status becomes completed, covering every generation pipeline and worker.
alter table public.generations
  add column if not exists generation_duration_seconds double precision
  check (generation_duration_seconds >= 0 and generation_duration_seconds < 'Infinity'::double precision);

comment on column public.generations.generation_duration_seconds is
  'Seconds from created_at to first successful completion; null for unfinished builds and historical rows without a recorded completion time.';

create or replace function public.record_generation_duration()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'completed' and new.created_at is not null then
    if tg_op = 'INSERT' then
      new.generation_duration_seconds := greatest(0, extract(epoch from clock_timestamp() - new.created_at));
    elsif old.generation_duration_seconds is not null then
      -- Heartbeats, metadata changes and later resizing cannot change the
      -- original build duration after it has been recorded.
      new.generation_duration_seconds := old.generation_duration_seconds;
    elsif old.status is distinct from 'completed' then
      new.generation_duration_seconds := greatest(0, extract(epoch from clock_timestamp() - new.created_at));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists record_generation_duration on public.generations;
create trigger record_generation_duration
  before insert or update of status on public.generations
  for each row execute function public.record_generation_duration();
