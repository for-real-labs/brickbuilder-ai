-- NULL preserves legacy generations; new Nova requests explicitly select a mode.
ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS nova_build_mode text;

ALTER TABLE public.generations
  ADD CONSTRAINT generations_nova_build_mode_check
  CHECK (nova_build_mode IS NULL OR
         (endpoint IS NOT DISTINCT FROM 'novaToBricks' AND nova_build_mode IN ('preview', 'verify')));
