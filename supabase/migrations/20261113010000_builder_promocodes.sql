-- Promo codes are private; only the authenticated backend can redeem them.
CREATE TABLE public.promocodes (
  code text PRIMARY KEY CHECK (code = lower(btrim(code)) AND length(code) BETWEEN 1 AND 100),
  type text NOT NULL CHECK (type IN ('builder'))
);
ALTER TABLE public.promocodes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promocodes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promocodes TO service_role;
INSERT INTO public.promocodes(code,type) VALUES ('friday13','builder');

CREATE FUNCTION public.redeem_promocode(p_user_id uuid, p_live boolean, p_code text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE verified_email text;
BEGIN
  SELECT lower(btrim(email)) INTO verified_email FROM auth.users
    WHERE id=p_user_id AND email_confirmed_at IS NOT NULL
      AND NOT coalesce(is_anonymous,false) AND coalesce(btrim(email),'')<>'';
  IF verified_email IS NULL THEN RETURN 'verification_required'; END IF;
  IF p_code IS NULL OR length(p_code)>100 OR NOT EXISTS (
    SELECT 1 FROM public.promocodes WHERE code=lower(btrim(p_code)) AND type='builder'
  ) THEN RETURN 'invalid_code'; END IF;
  INSERT INTO public.external_testers(email,livemode) VALUES (verified_email,p_live)
    ON CONFLICT DO NOTHING;
  PERFORM public.billing_account(p_user_id,p_live);
  RETURN 'builder';
END $$;
REVOKE ALL ON FUNCTION public.redeem_promocode(uuid,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_promocode(uuid,boolean,text) TO service_role;
NOTIFY pgrst,'reload schema';
