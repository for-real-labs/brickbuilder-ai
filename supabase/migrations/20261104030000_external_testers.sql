-- Comped Builder access is administered in Supabase, separately from store billing.
CREATE TABLE public.external_testers (
  email text NOT NULL CHECK (email=lower(btrim(email)) AND email<>''),
  livemode boolean NOT NULL DEFAULT true,
  PRIMARY KEY (email,livemode)
);
ALTER TABLE public.external_testers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.external_testers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.external_testers TO service_role;

ALTER TABLE public.billing_accounts ADD COLUMN external_tester boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.billing_account(p_user_id uuid,p_live boolean)
RETURNS public.billing_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  a public.billing_accounts;
  tester boolean;
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
      JOIN public.external_testers t ON t.email=lower(u.email) AND t.livemode=p_live
      WHERE u.id=p_user_id AND u.email_confirmed_at IS NOT NULL AND NOT coalesce(u.is_anonymous,false)
    );
  IF tester AND (NOT a.external_tester OR a.period_end<=now()) THEN
    UPDATE public.billing_accounts SET external_tester=true,monthly_remaining=225,monthly_credits=225,
      period_start=now(),period_end=month_end
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
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION public.require_generation_subscription() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE wallet public.billing_accounts;
BEGIN
 IF public.guest_generation_cost(NEW.endpoint)=0 OR NEW.user_id='developer' THEN
   RETURN NEW;
 END IF;
 IF NEW.user_type IS DISTINCT FROM 'authenticated' OR NEW.user_id IS NULL
    OR NEW.user_id !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
   RAISE EXCEPTION 'BB_SUBSCRIPTION_REQUIRED';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id=NEW.user_id::uuid) THEN
   RAISE EXCEPTION 'BB_SUBSCRIPTION_REQUIRED';
 END IF;
 wallet:=public.billing_account(NEW.user_id::uuid,NEW.billing_livemode);
 IF wallet.external_tester OR (wallet.apple_plan IS NOT NULL AND wallet.apple_expires_at>now())
    OR (wallet.plan_key IN ('builder','creator','master')
        AND wallet.subscription_status IN ('active','past_due') AND wallet.period_end>now()) THEN
   RETURN NEW;
 END IF;
 RAISE EXCEPTION 'BB_SUBSCRIPTION_REQUIRED';
END $$;

NOTIFY pgrst,'reload schema';
