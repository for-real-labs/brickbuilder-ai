-- Cancellation is separate from fulfillment so existing fulfillment workflows
-- and paid-order history remain intact. Administrators can edit this field in
-- the orders table; existing UPDATE policies still control who may change it.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cancelled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.orders.cancelled IS
  'Cancelled orders are no longer awaiting fulfillment. This does not refund or cancel a supplier purchase.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND conname = 'orders_not_cancelled_and_fulfilled'
  ) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_not_cancelled_and_fulfilled
      CHECK (NOT (cancelled AND COALESCE(fulfilled, false)));
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
