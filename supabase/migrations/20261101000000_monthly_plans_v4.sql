-- Whole-number credits: Basic 2, All parts / AI mesh 20. Purchased credits stay intact.
LOCK TABLE public.generations IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE public.billing_accounts ALTER COLUMN monthly_credits SET DEFAULT 75;
ALTER TABLE public.billing_accounts ALTER COLUMN monthly_remaining SET DEFAULT 75;
ALTER TABLE public.guest_credit_charges DROP CONSTRAINT guest_credit_charges_credits_check;
ALTER TABLE public.guest_credit_charges ADD CHECK (credits IN (1,2,15,20));

CREATE OR REPLACE FUNCTION public.guest_generation_cost(endpoint text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE WHEN endpoint='llmToBricks' THEN 2
   WHEN endpoint IN ('updateModel','resizeModel','uploadLdraw','glbToBricks','objToBricks') THEN 0 ELSE 20 END;
$$;

CREATE OR REPLACE FUNCTION public.billing_account(p_user_id uuid,p_live boolean)
RETURNS public.billing_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts;
BEGIN
  INSERT INTO public.billing_accounts(user_id,livemode) VALUES(p_user_id,p_live) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM public.billing_accounts WHERE user_id=p_user_id AND livemode=p_live FOR UPDATE;
  IF a.plan_key='free' AND a.period_end<=now() AND coalesce(a.apple_expires_at<=now(),true) THEN
    UPDATE public.billing_accounts SET monthly_remaining=75,monthly_credits=75,
      period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
      period_end=(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC'
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
    INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
    VALUES(p_user_id,p_live,'free:'||a.period_start,'monthly',75,'monthly',a.period_start) ON CONFLICT DO NOTHING;
  END IF;
  IF a.bonus_period_start < date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN
    UPDATE public.billing_accounts SET bonus_used=0,
      bonus_period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
  END IF;
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION public.billing_reserve_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; chosen_bucket text; cost integer; apple_cost integer:=0; monthly_cost integer;
BEGIN
 IF NEW.personal_billing THEN RETURN NEW; END IF;
 IF NOT (SELECT enabled FROM public.billing_settings WHERE id) THEN RETURN NEW; END IF;
 IF NEW.billing_policy_version<>2 THEN RAISE EXCEPTION 'BB_BILLING_VERSION'; END IF;
 IF NEW.endpoint IN ('updateModel','resizeModel','uploadLdraw','glbToBricks','objToBricks') THEN RETURN NEW; END IF;
 IF NEW.endpoint NOT IN ('llmToBricks','novaToBricks','textToBricks','imageToBricks','promptEditModel') THEN
   RAISE EXCEPTION 'BB_BILLING_VERSION';
 END IF;
 cost:=CASE WHEN NEW.endpoint='llmToBricks' THEN 2 ELSE 20 END;
 IF NEW.user_type<>'anonymous' AND NEW.user_id<>'developer' THEN
   a:=public.billing_account(NEW.user_id::uuid,NEW.billing_livemode);
   monthly_cost:=least(cost,CASE WHEN a.period_end>now() THEN a.monthly_remaining ELSE 0 END);
   apple_cost:=cost-monthly_cost;
   IF greatest(0,a.apple_remaining)>=apple_cost THEN
     chosen_bucket:=CASE WHEN monthly_cost=0 THEN 'apple' ELSE 'monthly' END;
     UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining-monthly_cost,
       apple_remaining=apple_remaining-apple_cost WHERE user_id=a.user_id AND livemode=a.livemode;
   ELSIF cost=2 AND a.bonus_remaining>=cost AND a.bonus_used+cost<=5 THEN
     chosen_bucket:='bonus'; apple_cost:=0;
     UPDATE public.billing_accounts SET bonus_remaining=bonus_remaining-cost,bonus_used=bonus_used+cost WHERE user_id=a.user_id AND livemode=a.livemode;
   ELSE RAISE EXCEPTION 'BB_CREDITS_EXHAUSTED';
   END IF;
   INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start,apple_amount)
   VALUES(a.user_id,a.livemode,NEW.id::text,'generation',-cost,chosen_bucket,
     CASE chosen_bucket WHEN 'bonus' THEN a.bonus_period_start ELSE a.period_start END,apple_cost);
 END IF;
 -- $20 per-job provider limit plus $1 for title/auxiliary work. No refund erases spend.
 PERFORM public.billing_reserve_ai(NEW.id::text,NEW.billing_livemode,'generation',21);
 RETURN NEW;
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
   UPDATE public.billing_accounts SET plan_key='free',monthly_remaining=75,monthly_credits=75,
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

CREATE OR REPLACE FUNCTION public.billing_apply_apple_transaction(p_user_id uuid,p_live boolean,p_transaction text,p_original text,
 p_plan text,p_start timestamptz,p_end timestamptz,p_version bigint,p_revoked boolean,p_upgraded boolean,p_allowance integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; old public.billing_apple_transactions; delta integer; effective_plan text; effective_end timestamptz; item public.billing_apple_transactions;
 old_total integer; new_total integer:=0; window_end timestamptz; window_allowance integer:=0; grant_amount integer; allowance integer;
BEGIN
 IF p_plan='builder' AND p_allowance IN (500,800) THEN p_allowance:=225; END IF;
 IF p_plan='creator' AND p_allowance=750 THEN p_allowance:=1500; END IF;
 IF p_plan NOT IN ('builder','creator') OR p_allowance IS DISTINCT FROM (CASE p_plan WHEN 'builder' THEN 225 ELSE 1500 END)
    OR p_start>=p_end OR p_start>now()+interval '5 minutes' THEN RAISE EXCEPTION 'APPLE_INVALID_TRANSACTION'; END IF;
 -- Serializes owner binding even if competing requests name different accounts.
 PERFORM pg_advisory_xact_lock(hashtextextended('apple:'||p_live||':'||p_original,0));
 IF EXISTS(SELECT 1 FROM public.billing_apple_transactions WHERE original_id=p_original AND livemode=p_live AND user_id<>p_user_id) THEN
   RAISE EXCEPTION 'APPLE_OWNER_MISMATCH';
 END IF;
 a:=public.billing_account(p_user_id,p_live);
 SELECT * INTO old FROM public.billing_apple_transactions WHERE transaction_id=p_transaction AND livemode=p_live;
 IF FOUND AND (old.user_id<>p_user_id OR old.original_id<>p_original) THEN RAISE EXCEPTION 'APPLE_OWNER_MISMATCH'; END IF;
 IF FOUND AND old.version>=p_version THEN RETURN; END IF;
 -- Recompute this chain in purchase order so late history, immediate upgrades,
 -- refunds and refund reversals converge to the same result. Overlapping paid
 -- periods grant only a positive allowance difference; switching plans repeatedly
 -- cannot mint another full month. A later non-overlapping renewal grants anew.
 SELECT coalesce(sum(granted),0) INTO old_total FROM public.billing_apple_transactions
 WHERE original_id=p_original AND livemode=p_live;
 INSERT INTO public.billing_apple_transactions VALUES(p_transaction,p_live,p_original,p_user_id,p_plan,p_start,p_end,p_version,
   p_revoked,p_upgraded,0,CASE WHEN p_start<'2026-10-27 00:00:00+00'::timestamptz THEN
     CASE p_plan WHEN 'builder' THEN 500 ELSE 750 END
     WHEN p_start<'2026-11-01T23:56:45.129524+00:00'::timestamptz THEN
     CASE p_plan WHEN 'builder' THEN 800 ELSE 1500 END ELSE p_allowance END)
 ON CONFLICT(transaction_id,livemode) DO UPDATE SET version=p_version,revoked=p_revoked,upgraded=p_upgraded;
 FOR item IN SELECT * FROM public.billing_apple_transactions WHERE original_id=p_original AND livemode=p_live
   ORDER BY starts_at,transaction_id LOOP
   grant_amount:=0;
   IF NOT item.revoked THEN
     allowance:=item.allowance;
     IF window_end IS NULL OR item.starts_at>=window_end THEN
       grant_amount:=allowance; window_allowance:=allowance; window_end:=item.expires_at;
     ELSE
       grant_amount:=greatest(0,allowance-window_allowance);
       window_allowance:=greatest(window_allowance,allowance); window_end:=greatest(window_end,item.expires_at);
     END IF;
   END IF;
   UPDATE public.billing_apple_transactions SET granted=grant_amount
   WHERE transaction_id=item.transaction_id AND livemode=p_live;
   new_total:=new_total+grant_amount;
 END LOOP;
 delta:=new_total-old_total;
 UPDATE public.billing_accounts SET apple_remaining=apple_remaining+delta WHERE user_id=p_user_id AND livemode=p_live;
 IF delta<>0 THEN
   INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start,apple_amount)
   VALUES(p_user_id,p_live,'apple:'||p_transaction||':'||p_version,CASE WHEN delta>0 THEN 'monthly' ELSE 'refund' END,delta,'apple',p_start,delta)
   ON CONFLICT DO NOTHING;
 END IF;
 SELECT plan,expires_at INTO effective_plan,effective_end FROM public.billing_apple_transactions
 WHERE user_id=p_user_id AND livemode=p_live AND NOT revoked AND NOT upgraded
 ORDER BY expires_at DESC LIMIT 1;
 UPDATE public.billing_accounts SET apple_plan=effective_plan,apple_expires_at=effective_end,
   monthly_remaining=CASE WHEN plan_key='free' AND effective_end>now() THEN 0 ELSE monthly_remaining END
 WHERE user_id=p_user_id AND livemode=p_live;
END $$;

-- Change the current monthly allowance once, preserving usage and purchased credits.
WITH adjustments AS (
 SELECT user_id,livemode,monthly_remaining old_remaining,
   greatest(0,monthly_remaining + CASE plan_key WHEN 'free' THEN 75 ELSE 225 END - monthly_credits) new_remaining
 FROM public.billing_accounts WHERE plan_key IN ('free','builder')
), updated AS (
 UPDATE public.billing_accounts a SET monthly_credits=CASE a.plan_key WHEN 'free' THEN 75 ELSE 225 END,
   monthly_remaining=x.new_remaining FROM adjustments x
 WHERE a.user_id=x.user_id AND a.livemode=x.livemode
 RETURNING a.*, x.new_remaining-x.old_remaining delta
)
INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
SELECT user_id,livemode,'monthly-plans-20261101','monthly',delta,'monthly',period_start
FROM updated WHERE delta<>0;
CREATE OR REPLACE FUNCTION public.billing_claim_trial() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; cost integer;
BEGIN
 IF OLD.user_type='anonymous' AND NEW.user_type='authenticated' AND NEW.user_id<>'developer'
   AND OLD.billing_policy_version=2 AND OLD.status NOT IN ('failed','cancelled')
   AND OLD.created_at>=(SELECT activated_at FROM public.billing_settings WHERE id) THEN
   -- Preserve the actual guest charge when a build predates this price change.
   SELECT credits INTO cost FROM public.guest_credit_charges WHERE generation_id=OLD.id;
   IF NOT FOUND THEN
     cost:=CASE WHEN OLD.endpoint='llmToBricks' THEN 1
       WHEN OLD.endpoint IN ('updateModel','resizeModel','uploadLdraw','glbToBricks','objToBricks') THEN 0 ELSE 15 END;
   END IF;
   IF cost=0 THEN RETURN NEW; END IF;
   a:=public.billing_account(NEW.user_id::uuid,NEW.billing_livemode);
   IF a.plan_key='free' AND OLD.created_at>=a.period_start AND a.monthly_remaining>0 THEN
     cost:=least(cost,a.monthly_remaining);
     INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
     VALUES(a.user_id,a.livemode,NEW.id::text,'generation',-cost,'monthly',a.period_start) ON CONFLICT DO NOTHING;
     IF FOUND THEN UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining-cost WHERE user_id=a.user_id AND livemode=a.livemode; END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;

NOTIFY pgrst,'reload schema';
