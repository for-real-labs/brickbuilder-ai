-- Keep AI cost accounting, but do not block service or purchases on monthly spending.
-- Billing enablement, credit admission, and the per-generation cost limit remain intact.
CREATE OR REPLACE FUNCTION public.billing_reserve_ai(p_reference text,p_live boolean,p_bucket text,p_amount numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s public.billing_settings;
BEGIN
 SELECT * INTO s FROM public.billing_settings WHERE id;
 IF NOT s.enabled THEN RETURN false; END IF;
 IF p_bucket NOT IN ('generation','assistant') OR p_amount<=0 OR p_amount>21 OR p_amount='NaN'::numeric THEN
   RAISE EXCEPTION 'BILLING_INVALID_RESERVATION';
 END IF;
 -- One lock across workers and months also serializes settlement with admission.
 PERFORM pg_advisory_xact_lock(hashtextextended('billing-budget:'||p_live,0));
 IF EXISTS(SELECT 1 FROM public.billing_ai_reservations WHERE reference=p_reference AND livemode=p_live) THEN
   RAISE EXCEPTION 'BILLING_DUPLICATE_RESERVATION';
 END IF;
 INSERT INTO public.billing_ai_reservations(reference,livemode,bucket,amount) VALUES(p_reference,p_live,p_bucket,p_amount);
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.billing_capacity(p_live boolean)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('available',s.enabled,'checkout_available',s.enabled)
 FROM public.billing_settings s WHERE s.id;
$$;
