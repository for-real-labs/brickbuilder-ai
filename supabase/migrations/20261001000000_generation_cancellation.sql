-- Cancellation is terminal; a late worker must not resurrect a stopped job.
alter table public.generations drop constraint if exists generations_status_check;
alter table public.generations add constraint generations_status_check
  check (status in ('queued', 'started', 'processing', 'in_progress', 'ldr_processing', 'unprocessed_ldr_saved', 'resizing', 'completed', 'failed', 'cancelled'));
