-- Credit refunds do not grant unlimited provider-funded retries. Keep the guard
-- separate from wallets, monthly resets, mutable ownership and model deletion.
LOCK TABLE public.generations IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE public.generation_retry_attempts (
 generation_id uuid NOT NULL,
 identity text NOT NULL,
 livemode boolean NOT NULL,
 admitted_at timestamptz NOT NULL,
 finished_at timestamptz,
 failed_at timestamptz,
 PRIMARY KEY(generation_id,identity)
);
CREATE INDEX generation_retry_failures ON public.generation_retry_attempts(identity,livemode,failed_at DESC)
 WHERE failed_at IS NOT NULL;
CREATE INDEX generation_retry_pending ON public.generation_retry_attempts(identity,livemode,admitted_at)
 WHERE finished_at IS NULL;
ALTER TABLE public.generation_retry_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_retry_attempts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.generation_retry_attempts TO service_role;

-- Historical jobs have no reliable terminal timestamp; retain their admission
-- time. Guest charge records recover original browser/network identities after
-- a claim. Old jobs without a network record can only seed their known owner.
INSERT INTO public.generation_retry_attempts
 SELECT g.id,keys.identity,g.billing_livemode,g.created_at,
   CASE WHEN g.status IN ('completed','failed','cancelled') THEN g.created_at END,
   CASE WHEN g.status IN ('failed','cancelled') THEN g.created_at END
 FROM public.generations g LEFT JOIN public.guest_credit_charges c ON c.generation_id=g.id
 CROSS JOIN LATERAL (
   SELECT CASE WHEN g.user_type='anonymous' THEN 'session:' ELSE 'account:' END||g.user_id AS identity
   UNION SELECT c.session_identity UNION SELECT c.network_identity
 ) keys
 WHERE NOT g.personal_billing AND public.guest_generation_cost(g.endpoint)>0 AND keys.identity IS NOT NULL;

CREATE FUNCTION public.enforce_generation_retry_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 g public.generations; identities text[]; key text; live boolean;
 admitted timestamptz; finished timestamptz; failed timestamptz; retry_until timestamptz;
 checked_at timestamptz:=statement_timestamp();
BEGIN
 IF TG_OP='DELETE' THEN g:=OLD; ELSE g:=NEW; END IF;
 IF g.personal_billing OR public.guest_generation_cost(g.endpoint)=0 THEN RETURN g; END IF;
 SELECT array_agg(DISTINCT identity ORDER BY identity) INTO identities FROM (
   SELECT identity FROM public.generation_retry_attempts WHERE generation_id=g.id
   UNION SELECT CASE WHEN g.user_type='anonymous' THEN 'session:' ELSE 'account:' END||g.user_id
   UNION SELECT 'network:'||g.guest_ip_hash WHERE TG_OP='INSERT' AND g.user_type='anonymous'
 ) keys WHERE identity IS NOT NULL;
 -- Take these locks before the existing guest/wallet/budget locks on every path.
 FOREACH key IN ARRAY identities LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('generation-retry:'||key,0));
 END LOOP;

 IF TG_OP='INSERT' THEN
   SELECT max(retry_at) INTO retry_until FROM unnest(identities) AS keys(identity)
   CROSS JOIN LATERAL (
     SELECT a.failed_at+interval '24 hours' AS retry_at FROM public.generation_retry_attempts a
     WHERE a.identity=keys.identity AND a.livemode=g.billing_livemode AND a.failed_at>checked_at-interval '24 hours'
     ORDER BY a.failed_at DESC OFFSET 2 LIMIT 1
   ) blocked;
   IF retry_until IS NOT NULL THEN
     RAISE EXCEPTION 'BB_GENERATION_RETRY_LIMIT:%',ceil(extract(epoch FROM retry_until))::bigint;
   END IF;
   -- Reserve the remaining retry slots for in-flight work too, preventing many
   -- browser identities on one network from racing ahead of the failure count.
   IF EXISTS(SELECT 1 FROM public.generation_retry_attempts
     WHERE identity=ANY(identities) AND livemode=g.billing_livemode
       AND (failed_at>checked_at-interval '24 hours'
         OR (finished_at IS NULL AND admitted_at>checked_at-interval '24 hours'))
     GROUP BY identity HAVING count(*)>=3) THEN
     RAISE EXCEPTION 'BB_GENERATION_RETRY_PENDING';
   END IF;
 END IF;

 SELECT min(admitted_at),min(finished_at),min(failed_at),bool_or(livemode)
 INTO admitted,finished,failed,live FROM public.generation_retry_attempts WHERE generation_id=g.id;
 admitted:=coalesce(admitted,checked_at);
 live:=coalesce(live,g.billing_livemode);
 IF g.status IN ('failed','cancelled') OR (TG_OP='DELETE' AND finished IS NULL) THEN
   failed:=coalesce(failed,checked_at);
 END IF;
 IF g.status IN ('completed','failed','cancelled') OR TG_OP='DELETE' THEN
   finished:=coalesce(finished,checked_at);
 END IF;
 INSERT INTO public.generation_retry_attempts
 SELECT g.id,identity,live,admitted,finished,failed FROM unnest(identities) AS keys(identity)
 ON CONFLICT(generation_id,identity) DO UPDATE
   SET finished_at=coalesce(generation_retry_attempts.finished_at,excluded.finished_at),
       failed_at=coalesce(generation_retry_attempts.failed_at,excluded.failed_at);
 RETURN g;
END $$;

-- Run before identity input is cleared and before refundable credits are touched.
CREATE TRIGGER generations_000_retry_guard BEFORE INSERT OR DELETE OR UPDATE OF status,user_id,user_type
 ON public.generations FOR EACH ROW EXECUTE FUNCTION public.enforce_generation_retry_guard();
REVOKE ALL ON FUNCTION public.enforce_generation_retry_guard() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
