-- Increase paid allowances without resetting usage or repricing historical Apple transactions.
ALTER TABLE public.billing_apple_transactions ADD COLUMN allowance integer;
UPDATE public.billing_apple_transactions SET allowance=CASE plan WHEN 'builder' THEN 500 ELSE 750 END;
ALTER TABLE public.billing_apple_transactions ALTER COLUMN allowance SET NOT NULL;
ALTER TABLE public.billing_apple_transactions ADD CHECK (allowance > 0);

-- Preserve spendable credits when starting a paid subscription.
-- Renewals keep the existing monthly reset; upgrades grant only the allowance difference.
CREATE OR REPLACE FUNCTION public.billing_sync_subscription(
 p_user_id uuid,p_live boolean,p_customer text,p_subscription text,p_status text,
 p_cancel boolean,p_version bigint,p_plan text,p_start timestamptz,p_end timestamptz,
 p_invoice text DEFAULT NULL,p_allowance integer DEFAULT NULL)
RETURNS public.billing_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; admitted text; credit_delta integer; entry_kind text;
BEGIN
 -- Accept in-flight calls from the previous backend during deployment.
 IF p_plan='builder' AND p_allowance=500 THEN p_allowance:=800; END IF;
 IF p_plan='creator' AND p_allowance=750 THEN p_allowance:=1500; END IF;
 a:=public.billing_account(p_user_id,p_live);
 IF a.stripe_customer_id IS DISTINCT FROM p_customer THEN RAISE EXCEPTION 'BILLING_CUSTOMER_MISMATCH'; END IF;
 IF a.stripe_subscription_id IS NOT NULL AND a.stripe_subscription_id<>p_subscription
    AND a.subscription_status NOT IN ('none','canceled','incomplete_expired') THEN RAISE EXCEPTION 'BILLING_DUPLICATE_SUBSCRIPTION'; END IF;
 IF p_version<a.sync_version THEN RETURN a; END IF;
 UPDATE public.billing_accounts SET stripe_subscription_id=p_subscription,subscription_status=p_status,
   cancel_at_period_end=p_cancel,sync_version=p_version WHERE user_id=p_user_id AND livemode=p_live;
 IF p_status IN ('canceled','incomplete_expired') THEN
   UPDATE public.billing_accounts SET plan_key='free',monthly_remaining=300,monthly_credits=300,
     period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
     period_end=(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC',cancel_at_period_end=false
   WHERE user_id=p_user_id AND livemode=p_live AND plan_key<>'free';
 ELSIF p_invoice IS NOT NULL AND p_status='active' AND p_end>now() AND p_start<=now() AND p_start<p_end THEN
   IF p_plan NOT IN ('builder','creator','master') OR p_allowance IS DISTINCT FROM
      (CASE p_plan WHEN 'builder' THEN 800 WHEN 'creator' THEN 1500 WHEN 'master' THEN 1000 END) THEN
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
 IF p_plan='builder' AND p_allowance=500 THEN p_allowance:=800; END IF;
 IF p_plan='creator' AND p_allowance=750 THEN p_allowance:=1500; END IF;
 IF p_plan NOT IN ('builder','creator') OR p_allowance IS DISTINCT FROM (CASE p_plan WHEN 'builder' THEN 800 ELSE 1500 END)
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
     CASE p_plan WHEN 'builder' THEN 500 ELSE 750 END ELSE p_allowance END)
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

-- Give current web subscribers the difference once, preserving spent and carried credits.
WITH adjustments AS (
 UPDATE public.billing_accounts
 SET monthly_remaining=monthly_remaining + CASE plan_key WHEN 'builder' THEN 800 ELSE 1500 END - monthly_credits,
     monthly_credits=CASE plan_key WHEN 'builder' THEN 800 ELSE 1500 END
 WHERE plan_key IN ('builder','creator') AND subscription_status='active' AND period_end>now()
   AND monthly_credits=CASE plan_key WHEN 'builder' THEN 500 ELSE 750 END
 RETURNING user_id,livemode,plan_key,period_start
)
INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
SELECT user_id,livemode,'paid-allowances-20261027','upgrade',CASE plan_key WHEN 'builder' THEN 300 ELSE 750 END,'monthly',period_start FROM adjustments;
