-- Custom Stripe purchases use versioned server quotes; existing purchases still reconcile.
ALTER TABLE public.billing_credit_purchases DROP CONSTRAINT billing_credit_purchases_pack_check;
ALTER TABLE public.billing_credit_purchases ADD CHECK(pack IN ('builder','creator','custom'));
CREATE OR REPLACE FUNCTION public.billing_apply_credit_pack(p_user_id uuid,p_live boolean,p_transaction text,p_pack text,p_version bigint,p_granted integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old public.billing_credit_purchases; delta integer; a public.billing_accounts;
BEGIN
 IF p_pack NOT IN ('builder','creator','custom') OR p_granted<0 OR p_granted>(CASE p_pack WHEN 'builder' THEN 800 WHEN 'creator' THEN 1500 ELSE 752508 END)
 OR (p_pack='custom' AND p_transaction !~ '^stripe:pi_')
 OR p_transaction !~ '^(stripe:pi_|apple:(sandbox|production):)[A-Za-z0-9_]+$' THEN RAISE EXCEPTION 'INVALID_CREDIT_PURCHASE'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('credit-pack:'||p_live||':'||p_transaction,0));
 a:=public.billing_account(p_user_id,p_live);
 SELECT * INTO old FROM public.billing_credit_purchases WHERE transaction_id=p_transaction AND livemode=p_live;
 IF FOUND AND (old.user_id<>p_user_id OR old.pack<>p_pack) THEN RAISE EXCEPTION 'CREDIT_PURCHASE_OWNER_MISMATCH'; END IF;
 IF FOUND AND old.version>=p_version THEN RETURN; END IF;
 delta:=p_granted-coalesce(old.granted,0);
 INSERT INTO public.billing_credit_purchases VALUES(p_transaction,p_live,p_user_id,p_pack,p_version,p_granted)
 ON CONFLICT(transaction_id,livemode) DO UPDATE SET version=p_version,granted=p_granted;
 UPDATE public.billing_accounts SET apple_remaining=apple_remaining+delta WHERE user_id=p_user_id AND livemode=p_live;
 IF delta<>0 THEN
 INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start,apple_amount)
 VALUES(p_user_id,p_live,p_transaction||':'||p_version,CASE WHEN delta>0 THEN 'purchase' ELSE 'purchase_refund' END,delta,'apple',now(),delta);
 END IF;
END $$;
NOTIFY pgrst,'reload schema';
