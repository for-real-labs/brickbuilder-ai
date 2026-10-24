-- Apple purchased credits are separate from expiring web/free allowances.
ALTER TABLE public.billing_accounts ADD COLUMN apple_remaining integer NOT NULL DEFAULT 0,
 ADD COLUMN apple_plan text, ADD COLUMN apple_expires_at timestamptz;
ALTER TABLE public.billing_credit_history ADD COLUMN apple_amount integer NOT NULL DEFAULT 0;
ALTER TABLE public.billing_credit_history DROP CONSTRAINT billing_credit_history_bucket_check;
ALTER TABLE public.billing_credit_history ADD CHECK(bucket IN ('monthly','bonus','apple'));
CREATE TABLE public.billing_apple_transactions (
 transaction_id text NOT NULL, livemode boolean NOT NULL, original_id text NOT NULL,
 user_id uuid NOT NULL, plan text NOT NULL CHECK(plan IN ('builder','creator')),
 starts_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, version bigint NOT NULL,
 revoked boolean NOT NULL, upgraded boolean NOT NULL, granted integer NOT NULL DEFAULT 0,
 PRIMARY KEY(transaction_id,livemode),
 FOREIGN KEY(user_id,livemode) REFERENCES public.billing_accounts(user_id,livemode) ON DELETE CASCADE
);
CREATE INDEX billing_apple_owner ON public.billing_apple_transactions(user_id,livemode);
ALTER TABLE public.billing_apple_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_apple_transactions FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.billing_apple_transactions TO service_role;

CREATE FUNCTION public.billing_apply_apple_transaction(p_user_id uuid,p_live boolean,p_transaction text,p_original text,
 p_plan text,p_start timestamptz,p_end timestamptz,p_version bigint,p_revoked boolean,p_upgraded boolean,p_allowance integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; old public.billing_apple_transactions; delta integer; effective_plan text; effective_end timestamptz; item public.billing_apple_transactions;
 old_total integer; new_total integer:=0; window_end timestamptz; window_allowance integer:=0; grant_amount integer; allowance integer;
BEGIN
 IF p_plan NOT IN ('builder','creator') OR p_allowance IS DISTINCT FROM (CASE p_plan WHEN 'builder' THEN 500 ELSE 750 END)
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
   p_revoked,p_upgraded,0)
 ON CONFLICT(transaction_id,livemode) DO UPDATE SET version=p_version,revoked=p_revoked,upgraded=p_upgraded;
 FOR item IN SELECT * FROM public.billing_apple_transactions WHERE original_id=p_original AND livemode=p_live
   ORDER BY starts_at,transaction_id LOOP
   grant_amount:=0;
   IF NOT item.revoked THEN
     allowance:=CASE item.plan WHEN 'builder' THEN 500 ELSE 750 END;
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
REVOKE ALL ON FUNCTION public.billing_apply_apple_transaction(uuid,boolean,text,text,text,timestamptz,timestamptz,bigint,boolean,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_apply_apple_transaction(uuid,boolean,text,text,text,timestamptz,timestamptz,bigint,boolean,boolean,integer) TO service_role;

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
 cost:=CASE WHEN NEW.endpoint='llmToBricks' THEN 1 ELSE 15 END;
 IF NEW.user_type<>'anonymous' AND NEW.user_id<>'developer' THEN
   a:=public.billing_account(NEW.user_id::uuid,NEW.billing_livemode);
   monthly_cost:=least(cost,CASE WHEN a.period_end>now() THEN a.monthly_remaining ELSE 0 END);
   apple_cost:=cost-monthly_cost;
   IF greatest(0,a.apple_remaining)>=apple_cost THEN
     chosen_bucket:=CASE WHEN monthly_cost=0 THEN 'apple' ELSE 'monthly' END;
     UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining-monthly_cost,
       apple_remaining=apple_remaining-apple_cost WHERE user_id=a.user_id AND livemode=a.livemode;
   ELSIF cost=1 AND a.bonus_remaining>0 AND a.bonus_used<5 THEN
     chosen_bucket:='bonus'; apple_cost:=0;
     UPDATE public.billing_accounts SET bonus_remaining=bonus_remaining-1,bonus_used=bonus_used+1 WHERE user_id=a.user_id AND livemode=a.livemode;
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

CREATE OR REPLACE FUNCTION public.billing_refund_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE charge public.billing_credit_history; a public.billing_accounts; refunded bigint;
BEGIN
 IF NEW.status NOT IN ('failed','cancelled') OR OLD.status IN ('failed','cancelled') THEN RETURN NEW; END IF;
 SELECT * INTO charge FROM public.billing_credit_history WHERE reference=NEW.id::text AND kind='generation';
 IF NOT FOUND THEN RETURN NEW; END IF;
 a:=public.billing_account(charge.user_id,charge.livemode);
 IF charge.bucket='monthly' AND charge.apple_amount=0 AND (charge.period_start<>a.period_start OR a.period_end<=now()) THEN RETURN NEW; END IF;
 INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start,apple_amount)
 VALUES(a.user_id,a.livemode,charge.reference,'refund',-charge.amount,charge.bucket,charge.period_start,charge.apple_amount)
 ON CONFLICT DO NOTHING RETURNING id INTO refunded;
 IF refunded IS NOT NULL THEN
   UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining+CASE WHEN charge.bucket='monthly' AND charge.period_start=a.period_start AND a.period_end>now() THEN -charge.amount-charge.apple_amount ELSE 0 END,
     apple_remaining=apple_remaining+charge.apple_amount,
     bonus_remaining=bonus_remaining+CASE WHEN charge.bucket='bonus' THEN -charge.amount ELSE 0 END,
     bonus_used=greatest(0,bonus_used-CASE WHEN charge.bucket='bonus' AND charge.period_start=a.bonus_period_start THEN -charge.amount ELSE 0 END)
   WHERE user_id=a.user_id AND livemode=a.livemode;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.billing_account(p_user_id uuid,p_live boolean)
RETURNS public.billing_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts;
BEGIN
  INSERT INTO public.billing_accounts(user_id,livemode) VALUES(p_user_id,p_live) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM public.billing_accounts WHERE user_id=p_user_id AND livemode=p_live FOR UPDATE;
  IF a.plan_key='free' AND a.period_end<=now() AND coalesce(a.apple_expires_at<=now(),true) THEN
    UPDATE public.billing_accounts SET monthly_remaining=300,monthly_credits=300,
      period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
      period_end=(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC'
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
    INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start)
    VALUES(p_user_id,p_live,'free:'||a.period_start,'monthly',300,'monthly',a.period_start) ON CONFLICT DO NOTHING;
  END IF;
  IF a.bonus_period_start < date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN
    UPDATE public.billing_accounts SET bonus_used=0,
      bonus_period_start=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    WHERE user_id=p_user_id AND livemode=p_live RETURNING * INTO a;
  END IF;
  RETURN a;
END $$;

NOTIFY pgrst,'reload schema';
