CREATE TABLE public.order_customs_ids (
  stripe_session_id text PRIMARY KEY,
  argentina_tax_id text NOT NULL CHECK (argentina_tax_id ~ '^[0-9]{11}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.order_customs_ids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_customs_ids FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.order_customs_ids TO service_role;

-- Keep abandoned sessions for seven days, beyond Stripe's normal webhook retry window.
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'purge-abandoned-order-customs-ids', '43 3 * * *', $$
    DELETE FROM public.order_customs_ids AS customs
    WHERE customs.created_at < now() - interval '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM public.orders AS orders
        WHERE orders.stripe_session_id = customs.stripe_session_id
      );
  $$
);
