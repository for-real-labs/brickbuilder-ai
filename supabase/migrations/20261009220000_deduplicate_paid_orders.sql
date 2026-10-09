-- Keep existing order history intact. Suppress repeat inserts for a Stripe
-- checkout/payment, including concurrent webhook deliveries and older workers.
CREATE INDEX IF NOT EXISTS orders_stripe_session_lookup
  ON public.orders (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_stripe_payment_lookup
  ON public.orders (stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_duplicate_paid_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  session_lock bigint;
  payment_lock bigint;
  existing public.orders%ROWTYPE;
BEGIN
  -- Lock both identifiers in a fixed order. The SELECT runs after waiting for
  -- the first delivery to commit, so parallel deliveries see its order.
  session_lock := pg_catalog.hashtextextended('order-session:' || NEW.stripe_session_id, 0);
  payment_lock := pg_catalog.hashtextextended('order-payment:' || NEW.stripe_payment_intent, 0);
  IF session_lock IS NOT NULL AND payment_lock IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(least(session_lock, payment_lock));
    PERFORM pg_catalog.pg_advisory_xact_lock(greatest(session_lock, payment_lock));
  ELSIF session_lock IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(session_lock);
  ELSIF payment_lock IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(payment_lock);
  ELSE
    RETURN NEW; -- Manual orders without a Stripe identifier remain supported.
  END IF;

  SELECT o.* INTO existing FROM public.orders o
    WHERE (NEW.stripe_session_id IS NOT NULL AND o.stripe_session_id = NEW.stripe_session_id)
       OR (NEW.stripe_payment_intent IS NOT NULL AND o.stripe_payment_intent = NEW.stripe_payment_intent)
    ORDER BY o.id LIMIT 1;
  IF FOUND THEN
    IF existing.generation_id IS DISTINCT FROM NEW.generation_id
       OR existing.amount_paid::numeric IS DISTINCT FROM NEW.amount_paid::numeric
       OR (existing.stripe_payment_intent IS NOT NULL AND NEW.stripe_payment_intent IS NOT NULL
           AND existing.stripe_payment_intent <> NEW.stripe_payment_intent) THEN
      RAISE EXCEPTION 'Stripe identifiers conflict with an existing order';
    END IF;
    -- Returning NULL means INSERT returns no row. The webhook only sends
    -- confirmation emails for an order actually inserted by this delivery.
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_duplicate_paid_order() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER orders_prevent_duplicate_payment BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.prevent_duplicate_paid_order();
