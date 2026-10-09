-- Allow the signed-in generations viewer to read the stored USD estimate.
-- Existing row policies still control which generations a user can read.
-- Detailed token usage and notification recipient fields remain server-only.
grant select (estimated_cost_usd) on public.generations to authenticated;

notify pgrst, 'reload schema';
