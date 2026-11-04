-- An unsubscribed account still owns its models, purchases and saved credits.
ALTER TABLE public.billing_accounts ALTER COLUMN monthly_credits SET DEFAULT 0;
ALTER TABLE public.billing_accounts ALTER COLUMN monthly_remaining SET DEFAULT 0;
UPDATE public.billing_accounts SET monthly_credits=0,monthly_remaining=0
WHERE plan_key='free' AND (monthly_credits<>0 OR monthly_remaining<>0);

CREATE OR REPLACE FUNCTION public.billing_account(p_user_id uuid,p_live boolean)
RETURNS public.billing_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts;
BEGIN
  INSERT INTO public.billing_accounts(user_id,livemode) VALUES(p_user_id,p_live) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM public.billing_accounts WHERE user_id=p_user_id AND livemode=p_live FOR UPDATE;
  IF a.plan_key='free' AND a.period_end<=now() AND coalesce(a.apple_expires_at<=now(),true) THEN
    UPDATE public.billing_accounts SET monthly_remaining=0,monthly_credits=0,
      period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
      period_end=(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC'
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
  END IF;
  IF a.bonus_period_start < date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN
    UPDATE public.billing_accounts SET bonus_used=0,
      bonus_period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
  END IF;
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION public.billing_sync_subscription(
 p_user_id uuid,p_live boolean,p_customer text,p_subscription text,p_status text,
 p_cancel boolean,p_version bigint,p_plan text,p_start timestamptz,p_end timestamptz,
 p_invoice text DEFAULT NULL,p_allowance integer DEFAULT NULL)
RETURNS public.billing_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; admitted text; credit_delta integer; entry_kind text;
BEGIN
 -- Accept in-flight calls from the previous backend during deployment.
 IF p_plan='builder' AND p_allowance IN (500,800) THEN p_allowance:=225; END IF;
 IF p_plan='creator' AND p_allowance=750 THEN p_allowance:=1500; END IF;
 a:=public.billing_account(p_user_id,p_live);
 IF a.stripe_customer_id IS DISTINCT FROM p_customer THEN RAISE EXCEPTION 'BILLING_CUSTOMER_MISMATCH'; END IF;
 IF a.stripe_subscription_id IS NOT NULL AND a.stripe_subscription_id<>p_subscription
    AND a.subscription_status NOT IN ('none','canceled','incomplete_expired') THEN RAISE EXCEPTION 'BILLING_DUPLICATE_SUBSCRIPTION'; END IF;
 IF p_version<a.sync_version THEN RETURN a; END IF;
 UPDATE public.billing_accounts SET stripe_subscription_id=p_subscription,subscription_status=p_status,
   cancel_at_period_end=p_cancel,sync_version=p_version WHERE user_id=p_user_id AND livemode=p_live;
 IF p_status IN ('canceled','incomplete_expired') THEN
   UPDATE public.billing_accounts SET plan_key='free',monthly_remaining=0,monthly_credits=0,
     period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
     period_end=(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC',cancel_at_period_end=false
   WHERE user_id=p_user_id AND livemode=p_live AND plan_key<>'free';
 ELSIF p_invoice IS NOT NULL AND p_status='active' AND p_end>now() AND p_start<=now() AND p_start<p_end THEN
   IF p_plan NOT IN ('builder','creator','master') OR p_allowance IS DISTINCT FROM
      (CASE p_plan WHEN 'builder' THEN 225 WHEN 'creator' THEN 1500 WHEN 'master' THEN 1000 END) THEN
      RAISE EXCEPTION 'BILLING_INVALID_PLAN';
   END IF;
   INSERT INTO public.billing_paid_invoices VALUES(p_invoice,p_live,p_user_id) ON CONFLICT DO NOTHING RETURNING invoice_id INTO admitted;
   IF admitted IS NOT NULL AND (a.plan_key='free' OR a.stripe_subscription_id IS DISTINCT FROM p_subscription OR p_start>=a.period_start) THEN
     IF a.plan_key='free' OR a.stripe_subscription_id IS DISTINCT FROM p_subscription OR p_start>a.period_start THEN
       credit_delta:=p_allowance; entry_kind:='monthly';
       UPDATE public.billing_accounts SET monthly_remaining=p_allowance + CASE
           WHEN (a.plan_key='free' OR a.stripe_subscription_id IS DISTINCT FROM p_subscription)
             AND a.period_end>now() THEN a.monthly_remaining ELSE 0 END,
         monthly_credits=p_allowance,
         period_start=p_start,period_end=p_end,plan_key=p_plan WHERE user_id=p_user_id AND livemode=p_live;
     ELSE
       credit_delta:=greatest(0,p_allowance-a.monthly_credits); entry_kind:='upgrade';
       UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining+credit_delta,
         monthly_credits=greatest(monthly_credits,p_allowance),period_end=p_end,plan_key=p_plan
       WHERE user_id=p_user_id AND livemode=p_live;
     END IF;
     INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
     VALUES(p_user_id,p_live,p_invoice,entry_kind,credit_delta,'monthly',p_start);
   END IF;
 END IF;
 SELECT * INTO a FROM public.billing_accounts WHERE user_id=p_user_id AND livemode=p_live;
 RETURN a;
END $$;

-- Run before the retry, guest, and wallet triggers. Rejected requests do not
-- create a generation or reserve credits, even with a personal provider key.
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
 SELECT * INTO wallet FROM public.billing_accounts
 WHERE user_id=NEW.user_id::uuid AND livemode=NEW.billing_livemode FOR UPDATE;
 IF (wallet.apple_plan IS NOT NULL AND wallet.apple_expires_at>now())
    OR (wallet.plan_key IN ('builder','creator','master')
        AND wallet.subscription_status IN ('active','past_due') AND wallet.period_end>now()) THEN
   RETURN NEW;
 END IF;
 RAISE EXCEPTION 'BB_SUBSCRIPTION_REQUIRED';
END $$;
REVOKE ALL ON FUNCTION public.require_generation_subscription() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS generations_0000_subscription ON public.generations;
CREATE TRIGGER generations_0000_subscription BEFORE INSERT ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.require_generation_subscription();
