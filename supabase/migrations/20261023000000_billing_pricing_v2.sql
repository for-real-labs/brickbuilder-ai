-- Version 2 stays disabled until the API, Stripe catalog and UI are deployed.
ALTER TABLE public.billing_settings ADD COLUMN policy_version integer NOT NULL DEFAULT 2;
ALTER TABLE public.billing_settings ADD COLUMN activated_at timestamptz;
ALTER TABLE public.billing_settings ADD COLUMN generation_budget_usd numeric NOT NULL DEFAULT 1500 CHECK (generation_budget_usd>0);
ALTER TABLE public.billing_settings ADD COLUMN assistant_budget_usd numeric NOT NULL DEFAULT 500 CHECK (assistant_budget_usd>0);
ALTER TABLE public.billing_accounts ADD COLUMN bonus_used integer NOT NULL DEFAULT 0 CHECK (bonus_used>=0);
ALTER TABLE public.billing_accounts ADD COLUMN bonus_period_start timestamptz NOT NULL
 DEFAULT (date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
ALTER TABLE public.generations ADD COLUMN billing_policy_version integer NOT NULL DEFAULT 1;

CREATE FUNCTION public.billing_activation() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NEW.enabled AND NEW.activated_at IS NULL THEN NEW.activated_at:=now(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_activation BEFORE UPDATE ON public.billing_settings FOR EACH ROW EXECUTE FUNCTION public.billing_activation();
REVOKE ALL ON FUNCTION public.billing_activation() FROM PUBLIC;

-- Include accounts created during the launch hold; never overwrite an existing wallet.
INSERT INTO public.billing_accounts(user_id,livemode,bonus_remaining)
SELECT p.id,true,greatest(0,coalesce(p.credits,0)) FROM public.user_profiles p JOIN auth.users u ON u.id=p.id
ON CONFLICT(user_id,livemode) DO NOTHING;
INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket)
SELECT user_id,livemode,'welcome','welcome',bonus_remaining,'bonus' FROM public.billing_accounts
WHERE livemode AND bonus_remaining>0 ON CONFLICT DO NOTHING;

-- Private reservations survive crashes, deleted jobs, refunds and billing toggles.
-- Failed/canceled jobs retain their full reservation when final spend is uncertain.
CREATE TABLE public.billing_ai_reservations (
 reference text NOT NULL,
 livemode boolean NOT NULL,
 bucket text NOT NULL CHECK (bucket IN ('generation','assistant')),
 period_start timestamptz NOT NULL DEFAULT (date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
 amount numeric NOT NULL CHECK (amount>=0 AND amount<>'NaN'::numeric),
 settled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(reference,livemode)
);
CREATE INDEX billing_ai_period ON public.billing_ai_reservations(livemode,period_start,bucket);
ALTER TABLE public.billing_ai_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_ai_reservations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.billing_ai_reservations TO service_role;

CREATE FUNCTION public.billing_reserve_ai(p_reference text,p_live boolean,p_bucket text,p_amount numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE limit_usd numeric; used_usd numeric; s public.billing_settings;
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
 limit_usd:=CASE p_bucket WHEN 'generation' THEN s.generation_budget_usd ELSE s.assistant_budget_usd END;
 SELECT coalesce(sum(amount),0) INTO used_usd FROM public.billing_ai_reservations
 WHERE livemode=p_live AND bucket=p_bucket AND period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 IF used_usd+p_amount>limit_usd THEN RAISE EXCEPTION 'BB_AI_CAPACITY' USING ERRCODE='P0001'; END IF;
 INSERT INTO public.billing_ai_reservations(reference,livemode,bucket,amount) VALUES(p_reference,p_live,p_bucket,p_amount);
 RETURN true;
END $$;

CREATE FUNCTION public.billing_settle_ai(p_reference text,p_live boolean,p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF p_amount<0 OR p_amount='NaN'::numeric THEN RAISE EXCEPTION 'BILLING_INVALID_SETTLEMENT'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('billing-budget:'||p_live,0));
 UPDATE public.billing_ai_reservations SET amount=CASE WHEN settled THEN greatest(amount,p_amount) ELSE p_amount END,settled=true
 WHERE reference=p_reference AND livemode=p_live;
END $$;

CREATE FUNCTION public.billing_capacity(p_live boolean)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('available',s.enabled AND s.generation_budget_usd-coalesce(sum(r.amount),0)>=21,
   'checkout_available',s.enabled AND s.generation_budget_usd-coalesce(sum(r.amount),0)>=200)
 FROM public.billing_settings s LEFT JOIN public.billing_ai_reservations r
 ON r.livemode=p_live AND r.bucket='generation'
 AND r.period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
 WHERE s.id GROUP BY s.enabled,s.generation_budget_usd;
$$;
CREATE OR REPLACE FUNCTION public.billing_account(p_user_id uuid,p_live boolean)
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
      (CASE p_plan WHEN 'builder' THEN 30 WHEN 'creator' THEN 75 WHEN 'master' THEN 180 END) THEN
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


CREATE OR REPLACE FUNCTION public.billing_reserve_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; chosen_bucket text; cost integer;
BEGIN
 IF NOT (SELECT enabled FROM public.billing_settings WHERE id) THEN RETURN NEW; END IF;
 IF NEW.billing_policy_version<>2 THEN RAISE EXCEPTION 'BB_BILLING_VERSION'; END IF;
 IF NEW.endpoint IN ('updateModel','resizeModel','uploadLdraw','glbToBricks','objToBricks') THEN RETURN NEW; END IF;
 IF NEW.endpoint NOT IN ('llmToBricks','novaToBricks','textToBricks','imageToBricks','promptEditModel') THEN
   RAISE EXCEPTION 'BB_BILLING_VERSION';
 END IF;
 cost:=CASE WHEN NEW.endpoint='llmToBricks' THEN 1 ELSE 15 END;
 IF NEW.user_type='anonymous' THEN
   IF cost<>1 THEN RAISE EXCEPTION 'BB_PAID_MODE_REQUIRED'; END IF;
 ELSIF NEW.user_id<>'developer' THEN
   a:=public.billing_account(NEW.user_id::uuid,NEW.billing_livemode);
   IF cost=15 AND (a.plan_key='free' OR a.period_end<=now() OR a.subscription_status NOT IN ('active','past_due')) THEN
     RAISE EXCEPTION 'BB_PAID_MODE_REQUIRED';
   END IF;
   IF a.period_end>now() AND a.monthly_remaining>=cost THEN
     chosen_bucket:='monthly';
     UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining-cost WHERE user_id=a.user_id AND livemode=a.livemode;
   ELSIF cost=1 AND a.bonus_remaining>0 AND a.bonus_used<5 THEN
     chosen_bucket:='bonus';
     UPDATE public.billing_accounts SET bonus_remaining=bonus_remaining-1,bonus_used=bonus_used+1 WHERE user_id=a.user_id AND livemode=a.livemode;
   ELSE RAISE EXCEPTION 'BB_CREDITS_EXHAUSTED';
   END IF;
   INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
   VALUES(a.user_id,a.livemode,NEW.id::text,'generation',-cost,chosen_bucket,
     CASE chosen_bucket WHEN 'bonus' THEN a.bonus_period_start ELSE a.period_start END);
 END IF;
 -- $20 per-job provider limit plus $1 for title/auxiliary work. No refund erases spend.
 PERFORM public.billing_reserve_ai(NEW.id::text,NEW.billing_livemode,'generation',21);
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.billing_refund_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE charge public.billing_credit_history; a public.billing_accounts; refunded bigint;
BEGIN
 IF NEW.status NOT IN ('failed','cancelled') OR OLD.status IN ('failed','cancelled') THEN RETURN NEW; END IF;
 SELECT * INTO charge FROM public.billing_credit_history WHERE reference=NEW.id::text AND kind='generation';
 IF NOT FOUND THEN RETURN NEW; END IF;
 a:=public.billing_account(charge.user_id,charge.livemode);
 IF charge.bucket='monthly' AND (charge.period_start<>a.period_start OR a.period_end<=now()) THEN RETURN NEW; END IF;
 INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
 VALUES(a.user_id,a.livemode,charge.reference,'refund',-charge.amount,charge.bucket,charge.period_start)
 ON CONFLICT DO NOTHING RETURNING id INTO refunded;
 IF refunded IS NOT NULL THEN
   UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining+CASE WHEN charge.bucket='monthly' THEN -charge.amount ELSE 0 END,
     bonus_remaining=bonus_remaining+CASE WHEN charge.bucket='bonus' THEN -charge.amount ELSE 0 END,
     bonus_used=greatest(0,bonus_used-CASE WHEN charge.bucket='bonus' AND charge.period_start=a.bonus_period_start THEN -charge.amount ELSE 0 END)
   WHERE user_id=a.user_id AND livemode=a.livemode;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.billing_generation_spend() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 -- Only successfully finished, fully tracked Basic/All parts jobs release the hold.
 -- Legacy mesh pipelines have unreported provider spend, so retain $21 conservatively.
 IF NEW.status='completed' AND NEW.endpoint IN ('llmToBricks','novaToBricks')
    AND NEW.ai_usage->>'finalized'='true'
    AND jsonb_array_length(coalesce(NEW.ai_usage->'calls','[]'::jsonb))>0 AND NEW.estimated_cost_usd IS NOT NULL THEN
   PERFORM public.billing_settle_ai(NEW.id::text,NEW.billing_livemode,NEW.estimated_cost_usd);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generations_billing_spend AFTER UPDATE OF status,estimated_cost_usd,ai_usage ON public.generations
 FOR EACH ROW EXECUTE FUNCTION public.billing_generation_spend();

CREATE FUNCTION public.billing_claim_trial() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts;
BEGIN
 IF OLD.user_type='anonymous' AND NEW.user_type='authenticated' AND NEW.user_id<>'developer'
   AND OLD.billing_policy_version=2 AND OLD.endpoint='llmToBricks' AND OLD.status NOT IN ('failed','cancelled')
   AND OLD.created_at>=(SELECT activated_at FROM public.billing_settings WHERE id) THEN
   a:=public.billing_account(NEW.user_id::uuid,NEW.billing_livemode);
   IF a.plan_key='free' AND OLD.created_at>=a.period_start AND a.monthly_remaining>0 THEN
     INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
     VALUES(a.user_id,a.livemode,NEW.id::text,'generation',-1,'monthly',a.period_start) ON CONFLICT DO NOTHING;
     IF FOUND THEN UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining-1 WHERE user_id=a.user_id AND livemode=a.livemode; END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generations_billing_claim BEFORE UPDATE OF user_id,user_type ON public.generations
 FOR EACH ROW EXECUTE FUNCTION public.billing_claim_trial();

REVOKE ALL ON FUNCTION public.billing_reserve_ai(text,boolean,text,numeric),public.billing_settle_ai(text,boolean,numeric),
 public.billing_capacity(boolean),public.billing_generation_spend(),public.billing_claim_trial() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_reserve_ai(text,boolean,text,numeric),public.billing_settle_ai(text,boolean,numeric),
 public.billing_capacity(boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_guest_generation(owner_id text, owner_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE admitted bigint;
BEGIN
    IF owner_type IS DISTINCT FROM 'anonymous' THEN RETURN; END IF;
    INSERT INTO public.generation_guest_usage (user_id, attempts) VALUES (owner_id, 1)
    ON CONFLICT (user_id) DO UPDATE SET attempts = generation_guest_usage.attempts + 1
    WHERE generation_guest_usage.attempts < CASE WHEN (SELECT enabled FROM public.billing_settings WHERE id) THEN 1 ELSE 3 END
    RETURNING attempts INTO admitted;
    IF admitted IS NULL THEN
        RAISE EXCEPTION 'BB_GENERATION_GUEST_LIMIT:%', CASE WHEN (SELECT enabled FROM public.billing_settings WHERE id) THEN 1 ELSE 3 END USING ERRCODE = 'P0001';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_guest_generation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_guest_generation(text, text) TO service_role;


CREATE OR REPLACE FUNCTION public.reserve_guest_ip_generation(network_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE admitted integer;
BEGIN
    IF network_hash IS NULL OR network_hash !~ '^ip_v1_[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'BB_GENERATION_GUEST_IP_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.anonymous_users (ip_hash, identity_type, call_count, first_call)
    VALUES (network_hash, 'ip_v1', 1, now())
    ON CONFLICT (ip_hash) DO UPDATE
    SET call_count = anonymous_users.call_count + 1, updated_at = now()
    WHERE anonymous_users.identity_type = 'ip_v1' AND anonymous_users.call_count < CASE WHEN (SELECT enabled FROM public.billing_settings WHERE id) THEN 1 ELSE 3 END
    RETURNING call_count INTO admitted;
    IF admitted IS NULL THEN
        RAISE EXCEPTION 'BB_GENERATION_GUEST_LIMIT:%', CASE WHEN (SELECT enabled FROM public.billing_settings WHERE id) THEN 1 ELSE 3 END USING ERRCODE = 'P0001';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_guest_ip_generation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_guest_ip_generation(text) TO service_role;


NOTIFY pgrst,'reload schema';
