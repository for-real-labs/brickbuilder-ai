-- Keep the configured total-parts limit on every revision, independently of browser state.
ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS max_parts integer CHECK (max_parts BETWEEN 1 AND 100000);
COMMENT ON COLUMN public.generations.max_parts IS 'Original maximum physical-parts limit, inherited by edits; NULL means no saved limit.';
NOTIFY pgrst, 'reload schema';
