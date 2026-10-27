-- Purchased credits share the existing non-expiring wallet bucket (historically
-- named apple_remaining). This retains atomic spending and failed-build refunds.
CREATE TABLE public.billing_credit_purchases (
 transaction_id text NOT NULL, livemode boolean NOT NULL, user_id uuid NOT NULL,
 pack text NOT NULL CHECK(pack IN ('builder','creator')), version bigint NOT NULL,
 granted integer NOT NULL, PRIMARY KEY(transaction_id,livemode),
 FOREIGN KEY(user_id,livemode) REFERENCES public.billing_accounts(user_id,livemode)
);
ALTER TABLE public.billing_credit_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_credit_purchases FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.billing_credit_purchases TO service_role;
ALTER TABLE public.billing_credit_history DROP CONSTRAINT billing_credit_history_kind_check;
ALTER TABLE public.billing_credit_history ADD CHECK(kind IN ('welcome','monthly','upgrade','generation','refund','purchase','purchase_refund'));
CREATE FUNCTION public.billing_apply_credit_pack(p_user_id uuid,p_live boolean,p_transaction text,p_pack text,p_version bigint,p_granted integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old public.billing_credit_purchases; delta integer; a public.billing_accounts;
BEGIN
 IF p_pack NOT IN ('builder','creator') OR p_granted<0 OR p_granted>(CASE p_pack WHEN 'builder' THEN 800 ELSE 1500 END)
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
REVOKE ALL ON FUNCTION public.billing_apply_credit_pack(uuid,boolean,text,text,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_apply_credit_pack(uuid,boolean,text,text,bigint,integer) TO service_role;
NOTIFY pgrst,'reload schema';
