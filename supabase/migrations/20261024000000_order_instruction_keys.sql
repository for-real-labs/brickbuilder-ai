-- A per-order bearer key unlocks only that order's exact model instructions.
-- Raw keys live only in delivery emails/QR codes; never in public model rows.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS instructions_key_hash text;

CREATE INDEX IF NOT EXISTS orders_instructions_key_lookup
  ON public.orders (generation_id, instructions_key_hash)
  WHERE instructions_key_hash IS NOT NULL AND cancelled = false;

COMMENT ON COLUMN public.orders.instructions_key_hash IS
  'SHA-256 of the random instruction-link key. NULL revokes link access. Never store the raw key here.';

NOTIFY pgrst, 'reload schema';
