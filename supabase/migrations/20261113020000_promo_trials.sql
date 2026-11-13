-- NULL tester expiry means permanent access; existing testers remain permanent.
ALTER TABLE public.promocodes ADD COLUMN expires timestamptz;
ALTER TABLE public.promocodes ADD COLUMN trial_duration_days integer NOT NULL DEFAULT 30 CHECK (trial_duration_days BETWEEN 1 AND 365);
ALTER TABLE public.external_testers ADD COLUMN expires timestamptz;
GRANT UPDATE ON public.external_testers TO service_role;
ALTER TABLE public.billing_accounts ADD COLUMN external_tester_expires_at timestamptz;
-- End of Sunday, November 15 in America/Chicago, exclusive cutoff.
UPDATE public.promocodes SET expires='2026-11-16 00:00:00 America/Chicago',trial_duration_days=30 WHERE code='friday13';

CREATE OR REPLACE FUNCTION public.billing_account(p_user_id uuid,p_live boolean)
RETURNS public.billing_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  a public.billing_accounts;
  tester boolean;
  tester_end timestamptz;
  month_start timestamptz := date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  month_end timestamptz := (date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC';
BEGIN
  INSERT INTO public.billing_accounts(user_id,livemode) VALUES(p_user_id,p_live) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM public.billing_accounts WHERE user_id=p_user_id AND livemode=p_live FOR UPDATE;
  -- Existing store subscriptions keep their normal billing and allowances.
  tester := a.plan_key='free'
    AND a.subscription_status IN ('none','canceled','incomplete_expired')
    AND coalesce(a.apple_expires_at<=now(),true)
    AND EXISTS (
      SELECT 1 FROM auth.users u
      JOIN public.external_testers t ON t.email=lower(u.email) AND t.livemode=p_live AND (t.expires IS NULL OR t.expires>now())
      WHERE u.id=p_user_id AND u.email_confirmed_at IS NOT NULL AND NOT coalesce(u.is_anonymous,false)
    );
  SELECT t.expires INTO tester_end FROM public.external_testers t
    JOIN auth.users u ON lower(u.email)=t.email WHERE u.id=p_user_id AND t.livemode=p_live;
  IF tester AND (NOT a.external_tester OR a.period_end<=now()) THEN
    UPDATE public.billing_accounts SET external_tester=true,monthly_remaining=225,monthly_credits=225,
      period_start=now(),period_end=least(month_end,tester_end)
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
    INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
    VALUES(p_user_id,p_live,'external-tester:'||a.period_start,'monthly',225,'monthly',a.period_start);
  ELSIF NOT tester AND (a.external_tester OR
      (a.plan_key='free' AND a.period_end<=now() AND coalesce(a.apple_expires_at<=now(),true))) THEN
    UPDATE public.billing_accounts SET external_tester=false,
      monthly_remaining=CASE WHEN a.plan_key='free' THEN 0 ELSE monthly_remaining END,
      monthly_credits=CASE WHEN a.plan_key='free' THEN 0 ELSE monthly_credits END,
      period_start=CASE WHEN a.plan_key='free' THEN month_start ELSE period_start END,
      period_end=CASE WHEN a.plan_key='free' THEN month_end ELSE period_end END
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
  END IF;
  IF a.bonus_period_start < month_start THEN
    UPDATE public.billing_accounts SET bonus_used=0,
      bonus_period_start=month_start
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
  END IF;
  UPDATE public.billing_accounts SET external_tester_expires_at=CASE WHEN tester THEN tester_end ELSE NULL END,
    period_end=CASE WHEN tester THEN least(period_end,tester_end) ELSE period_end END
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION public.redeem_promocode(p_user_id uuid, p_live boolean, p_code text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE verified_email text; trial_days integer; tester_end timestamptz;
BEGIN
  SELECT lower(btrim(email)) INTO verified_email FROM auth.users
    WHERE id=p_user_id AND email_confirmed_at IS NOT NULL
      AND NOT coalesce(is_anonymous,false) AND coalesce(btrim(email),'')<>'';
  IF verified_email IS NULL THEN RETURN 'verification_required'; END IF;
  IF p_code IS NULL OR length(p_code)>100 THEN RETURN 'invalid_code'; END IF;
  SELECT trial_duration_days INTO trial_days FROM public.promocodes
    WHERE code=lower(btrim(p_code)) AND type='builder' AND (expires IS NULL OR expires>now());
  IF trial_days IS NULL THEN RETURN 'invalid_code'; END IF;
  INSERT INTO public.external_testers(email,livemode,expires)
    VALUES (verified_email,p_live,now()+make_interval(days=>trial_days))
    ON CONFLICT DO NOTHING;
  SELECT expires INTO tester_end FROM public.external_testers WHERE email=verified_email AND livemode=p_live;
  IF tester_end<=now() THEN RETURN 'trial_expired'; END IF;
  PERFORM public.billing_account(p_user_id,p_live);
  RETURN 'builder';
END $$;
REVOKE ALL ON FUNCTION public.redeem_promocode(uuid,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_promocode(uuid,boolean,text) TO service_role;
NOTIFY pgrst,'reload schema';
