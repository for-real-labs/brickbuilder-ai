-- Install before the API/UI rollout; enable only after Stripe and both deploys pass.
CREATE TABLE public.billing_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  live_portal_id text,
  test_portal_id text
);
INSERT INTO public.billing_settings(id) VALUES (true);
CREATE TABLE public.billing_accounts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  livemode boolean NOT NULL,
  plan_key text NOT NULL DEFAULT 'free' CHECK (plan_key IN ('free','builder','creator','master')),
  monthly_credits integer NOT NULL DEFAULT 5 CHECK (monthly_credits >= 0),
  monthly_remaining integer NOT NULL DEFAULT 5 CHECK (monthly_remaining >= 0),
  bonus_remaining integer NOT NULL DEFAULT 0 CHECK (bonus_remaining >= 0),
  period_start timestamptz NOT NULL DEFAULT (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  period_end timestamptz NOT NULL DEFAULT ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'),
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text NOT NULL DEFAULT 'none',
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  sync_version bigint NOT NULL DEFAULT 0,
  checkout_lock_until timestamptz,
  PRIMARY KEY(user_id,livemode),
  UNIQUE(stripe_customer_id,livemode),
  UNIQUE(stripe_subscription_id,livemode)
);
CREATE TABLE public.billing_credit_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  livemode boolean NOT NULL,
  reference text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('welcome','monthly','upgrade','generation','refund')),
  amount integer NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('monthly','bonus')),
  period_start timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,livemode,reference,kind),
  FOREIGN KEY(user_id,livemode) REFERENCES public.billing_accounts(user_id,livemode) ON DELETE CASCADE
);
CREATE INDEX billing_history_owner ON public.billing_credit_history(user_id,livemode,id DESC);
CREATE TABLE public.billing_paid_invoices (
  invoice_id text NOT NULL,
  livemode boolean NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY(invoice_id,livemode),
  FOREIGN KEY(user_id,livemode) REFERENCES public.billing_accounts(user_id,livemode) ON DELETE CASCADE
);
ALTER TABLE public.billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_credit_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_paid_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_settings, public.billing_accounts, public.billing_credit_history, public.billing_paid_invoices FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.billing_settings, public.billing_accounts, public.billing_credit_history, public.billing_paid_invoices TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.billing_credit_history_id_seq TO service_role;

-- Keep all existing balances as one-time bonus credits; they never expire.
INSERT INTO public.billing_accounts(user_id,livemode,bonus_remaining)
SELECT p.id,true,greatest(0,coalesce(p.credits,0)) FROM public.user_profiles p JOIN auth.users u ON u.id=p.id;
INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket)
SELECT user_id,livemode,'welcome','welcome',bonus_remaining,'bonus' FROM public.billing_accounts WHERE bonus_remaining>0;

CREATE FUNCTION public.billing_account(p_user_id uuid,p_live boolean)
RETURNS public.billing_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts;
BEGIN
  INSERT INTO public.billing_accounts(user_id,livemode) VALUES(p_user_id,p_live) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM public.billing_accounts WHERE user_id=p_user_id AND livemode=p_live FOR UPDATE;
  IF a.plan_key='free' AND a.period_end<=now() THEN
    UPDATE public.billing_accounts SET monthly_remaining=5,monthly_credits=5,
      period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
      period_end=(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC'
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
    INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
    VALUES(p_user_id,p_live,'free:'||a.period_start,'monthly',5,'monthly',a.period_start) ON CONFLICT DO NOTHING;
  END IF;
  RETURN a;
END $$;

CREATE FUNCTION public.billing_checkout_lock(p_user_id uuid,p_live boolean,p_acquire boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts;
BEGIN
  a:=public.billing_account(p_user_id,p_live);
  IF p_acquire AND a.checkout_lock_until>now() THEN RETURN false; END IF;
  UPDATE public.billing_accounts SET checkout_lock_until=CASE WHEN p_acquire THEN now()+interval '90 seconds' ELSE NULL END
    WHERE user_id=p_user_id AND livemode=p_live;
  RETURN true;
END $$;

-- A paid invoice is applied once, even if Checkout and several webhooks race.
-- Within a billing period only the difference on an upgrade is granted. A
-- downgrade/re-upgrade cannot farm credits; the largest allowance is retained.
CREATE FUNCTION public.billing_sync_subscription(
 p_user_id uuid,p_live boolean,p_customer text,p_subscription text,p_status text,
 p_cancel boolean,p_version bigint,p_plan text,p_start timestamptz,p_end timestamptz,
 p_invoice text DEFAULT NULL,p_allowance integer DEFAULT NULL)
RETURNS public.billing_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; admitted text; credit_delta integer; entry_kind text;
BEGIN
 a:=public.billing_account(p_user_id,p_live);
 IF a.stripe_customer_id IS DISTINCT FROM p_customer THEN RAISE EXCEPTION 'BILLING_CUSTOMER_MISMATCH'; END IF;
 IF a.stripe_subscription_id IS NOT NULL AND a.stripe_subscription_id<>p_subscription
    AND a.subscription_status NOT IN ('none','canceled','incomplete_expired') THEN RAISE EXCEPTION 'BILLING_DUPLICATE_SUBSCRIPTION'; END IF;
 IF p_version<a.sync_version THEN RETURN a; END IF;
 UPDATE public.billing_accounts SET stripe_subscription_id=p_subscription,subscription_status=p_status,
   cancel_at_period_end=p_cancel,sync_version=p_version WHERE user_id=p_user_id AND livemode=p_live;
 IF p_status IN ('canceled','incomplete_expired') THEN
   UPDATE public.billing_accounts SET plan_key='free',monthly_remaining=5,monthly_credits=5,
     period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
     period_end=(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC',cancel_at_period_end=false
   WHERE user_id=p_user_id AND livemode=p_live AND plan_key<>'free';
 ELSIF p_invoice IS NOT NULL AND p_status='active' AND p_end>now() AND p_start<=now() AND p_start<p_end THEN
   IF p_plan NOT IN ('builder','creator','master') OR p_allowance IS DISTINCT FROM
      (CASE p_plan WHEN 'builder' THEN 30 WHEN 'creator' THEN 100 WHEN 'master' THEN 300 END) THEN
      RAISE EXCEPTION 'BILLING_INVALID_PLAN';
   END IF;
   INSERT INTO public.billing_paid_invoices VALUES(p_invoice,p_live,p_user_id) ON CONFLICT DO NOTHING RETURNING invoice_id INTO admitted;
   IF admitted IS NOT NULL AND (a.plan_key='free' OR a.stripe_subscription_id IS DISTINCT FROM p_subscription OR p_start>=a.period_start) THEN
     IF a.plan_key='free' OR a.stripe_subscription_id IS DISTINCT FROM p_subscription OR p_start>a.period_start THEN
       credit_delta:=p_allowance; entry_kind:='monthly';
       UPDATE public.billing_accounts SET monthly_remaining=p_allowance,monthly_credits=p_allowance,
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

ALTER TABLE public.generations ADD COLUMN billing_livemode boolean NOT NULL DEFAULT true;
CREATE FUNCTION public.billing_reserve_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; chosen_bucket text;
BEGIN
 IF NOT (SELECT enabled FROM public.billing_settings WHERE id) OR NEW.user_type<>'authenticated' OR NEW.user_id='developer'
    OR NEW.endpoint IN ('updateModel','resizeModel','uploadLdraw') THEN RETURN NEW; END IF;
 a:=public.billing_account(NEW.user_id::uuid,NEW.billing_livemode);
 IF a.period_end>now() AND a.monthly_remaining>0 THEN
   chosen_bucket:='monthly';
   UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining-1 WHERE user_id=a.user_id AND livemode=a.livemode;
 ELSIF a.bonus_remaining>0 THEN
   chosen_bucket:='bonus';
   UPDATE public.billing_accounts SET bonus_remaining=bonus_remaining-1 WHERE user_id=a.user_id AND livemode=a.livemode;
 ELSE
   RAISE EXCEPTION 'BB_CREDITS_EXHAUSTED' USING ERRCODE='P0001';
 END IF;
 INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
 VALUES(a.user_id,a.livemode,NEW.id::text,'generation',-1,chosen_bucket,a.period_start);
 RETURN NEW;
END $$;
CREATE TRIGGER generations_1_billing BEFORE INSERT ON public.generations FOR EACH ROW EXECUTE FUNCTION public.billing_reserve_generation();

CREATE FUNCTION public.billing_refund_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE charge public.billing_credit_history; a public.billing_accounts; refunded bigint;
BEGIN
 IF NEW.status NOT IN ('failed','cancelled') OR OLD.status IN ('failed','cancelled') THEN RETURN NEW; END IF;
 SELECT * INTO charge FROM public.billing_credit_history WHERE reference=NEW.id::text AND kind='generation';
 IF NOT FOUND THEN RETURN NEW; END IF;
 a:=public.billing_account(charge.user_id,charge.livemode);
 -- Never replenish a different month's credits with an old failed job.
 IF charge.bucket='monthly' AND (charge.period_start<>a.period_start OR a.period_end<=now()) THEN RETURN NEW; END IF;
 INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
 VALUES(a.user_id,a.livemode,charge.reference,'refund',1,charge.bucket,charge.period_start)
 ON CONFLICT DO NOTHING RETURNING id INTO refunded;
 IF refunded IS NOT NULL THEN
   UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining+CASE WHEN charge.bucket='monthly' THEN 1 ELSE 0 END,
     bonus_remaining=bonus_remaining+CASE WHEN charge.bucket='bonus' THEN 1 ELSE 0 END WHERE user_id=a.user_id AND livemode=a.livemode;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generations_billing_refund AFTER UPDATE OF status ON public.generations FOR EACH ROW EXECUTE FUNCTION public.billing_refund_generation();

-- Browsers must not forge success/failure, change a metered owner or bypass
-- admission. All mutation endpoints already authenticate through the API.
REVOKE INSERT, UPDATE, DELETE ON public.generations FROM anon, authenticated;
-- Legacy credits are informational only; the new wallet is service-only.
REVOKE UPDATE ON public.user_profiles FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_account(uuid,boolean),public.billing_checkout_lock(uuid,boolean,boolean),
 public.billing_sync_subscription(uuid,boolean,text,text,text,boolean,bigint,text,timestamptz,timestamptz,text,integer),
 public.billing_reserve_generation(),public.billing_refund_generation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_account(uuid,boolean),public.billing_checkout_lock(uuid,boolean,boolean),
 public.billing_sync_subscription(uuid,boolean,text,text,text,boolean,bigint,text,timestamptz,timestamptz,text,integer) TO service_role;
NOTIFY pgrst,'reload schema';
