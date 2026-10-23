-- Hosted guests share 75 lifetime credits: Basic=1; All parts/AI mesh=15.
-- Keep admission and refunds independent of mutable/deleted model ownership.
LOCK TABLE public.generations IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE public.guest_credit_usage (
 identity text PRIMARY KEY,
 credits_used bigint NOT NULL CHECK (credits_used>=0)
);
CREATE TABLE public.guest_credit_charges (
 generation_id uuid PRIMARY KEY,
 session_identity text NOT NULL,
 network_identity text NOT NULL,
 credits integer NOT NULL CHECK (credits IN (1,15)),
 refunded boolean NOT NULL DEFAULT false
);
ALTER TABLE public.guest_credit_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_credit_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.guest_credit_usage,public.guest_credit_charges FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.guest_credit_usage,public.guest_credit_charges TO service_role;

CREATE FUNCTION public.guest_generation_cost(endpoint text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE WHEN endpoint='llmToBricks' THEN 1
   WHEN endpoint IN ('updateModel','resizeModel','uploadLdraw','glbToBricks','objToBricks') THEN 0 ELSE 15 END;
$$;

-- Preserve spent trials. Known model modes use their weight; deleted/claimed
-- attempts with no remaining mode record retain one credit each. Network hashes
-- were deliberately not stored on models, so historical IP attempts retain one
-- credit each. Future charges record both identities privately and exactly.
WITH known AS (
 SELECT user_id,count(*) attempts,sum(public.guest_generation_cost(endpoint)) credits
 FROM public.generations WHERE user_type='anonymous' AND user_id IS NOT NULL GROUP BY user_id
)
INSERT INTO public.guest_credit_usage(identity,credits_used)
 SELECT 'session:'||coalesce(g.user_id,k.user_id),
   greatest(coalesce(g.attempts,0)-coalesce(k.attempts,0),0)+coalesce(k.credits,0)
 FROM public.generation_guest_usage g FULL JOIN known k ON k.user_id=g.user_id;
INSERT INTO public.guest_credit_usage(identity,credits_used)
 SELECT 'network:'||ip_hash,greatest(call_count,0) FROM public.anonymous_users WHERE identity_type='ip_v1';

CREATE FUNCTION public.reserve_guest_credits(generation uuid,owner_id text,network_hash text,endpoint text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cost integer:=public.guest_generation_cost(endpoint); admitted bigint;
BEGIN
 IF cost=0 THEN RETURN; END IF;
 IF owner_id IS NULL OR owner_id='' THEN RAISE EXCEPTION 'BB_GENERATION_GUEST_IP_REQUIRED'; END IF;
 IF network_hash IS NULL OR network_hash !~ '^ip_v1_[0-9a-f]{64}$' THEN
   RAISE EXCEPTION 'BB_GENERATION_GUEST_IP_REQUIRED';
 END IF;
 INSERT INTO public.guest_credit_charges VALUES(generation,'session:'||owner_id,'network:'||network_hash,cost,false);
 INSERT INTO public.guest_credit_usage VALUES('session:'||owner_id,cost)
 ON CONFLICT(identity) DO UPDATE SET credits_used=guest_credit_usage.credits_used+cost
 WHERE guest_credit_usage.credits_used+cost<=75 RETURNING credits_used INTO admitted;
 IF admitted IS NULL THEN RAISE EXCEPTION 'BB_GUEST_CREDITS_EXHAUSTED'; END IF;
 INSERT INTO public.guest_credit_usage VALUES('network:'||network_hash,cost)
 ON CONFLICT(identity) DO UPDATE SET credits_used=guest_credit_usage.credits_used+cost
 WHERE guest_credit_usage.credits_used+cost<=75 RETURNING credits_used INTO admitted;
 IF admitted IS NULL THEN RAISE EXCEPTION 'BB_GUEST_CREDITS_EXHAUSTED'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_generation_guest_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.user_type='anonymous' THEN
   PERFORM public.reserve_guest_credits(NEW.id,NEW.user_id,NEW.guest_ip_hash,NEW.endpoint);
 END IF;
 NEW.guest_ip_hash:=NULL;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS generations_0_guest_limit ON public.generations;
CREATE TRIGGER generations_0_guest_limit BEFORE INSERT ON public.generations
 FOR EACH ROW EXECUTE FUNCTION public.enforce_generation_guest_limit();

CREATE FUNCTION public.refund_guest_credits() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE charge public.guest_credit_charges;
BEGIN
 IF NEW.status NOT IN ('failed','cancelled') THEN RETURN NEW; END IF;
 UPDATE public.guest_credit_charges SET refunded=true
 WHERE generation_id=NEW.id AND NOT refunded RETURNING * INTO charge;
 IF FOUND THEN
   UPDATE public.guest_credit_usage SET credits_used=greatest(0,credits_used-charge.credits) WHERE identity=charge.session_identity;
   UPDATE public.guest_credit_usage SET credits_used=greatest(0,credits_used-charge.credits) WHERE identity=charge.network_identity;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generations_guest_credit_refund AFTER INSERT OR UPDATE OF status ON public.generations
 FOR EACH ROW EXECUTE FUNCTION public.refund_guest_credits();

CREATE OR REPLACE FUNCTION public.billing_claim_trial() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; cost integer;
BEGIN
 IF OLD.user_type='anonymous' AND NEW.user_type='authenticated' AND NEW.user_id<>'developer'
   AND OLD.billing_policy_version=2 AND OLD.status NOT IN ('failed','cancelled')
   AND OLD.created_at>=(SELECT activated_at FROM public.billing_settings WHERE id) THEN
   cost:=public.guest_generation_cost(OLD.endpoint);
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

REVOKE ALL ON FUNCTION public.guest_generation_cost(text),public.reserve_guest_credits(uuid,text,text,text),
 public.enforce_generation_guest_limit(),public.refund_guest_credits() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guest_generation_cost(text),public.reserve_guest_credits(uuid,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_reserve_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; chosen_bucket text; cost integer;
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


-- The lifetime allowance replaces the default daily guest cap; explicit overrides remain.
CREATE OR REPLACE FUNCTION public.reserve_daily_generation(owner_id text, owner_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
    admitted integer;
    effective_limit integer;
    exempt boolean;
BEGIN
    SELECT daily_limit, unlimited INTO effective_limit, exempt FROM public.generation_daily_limit_overrides
    WHERE user_id = owner_id AND user_type = owner_type;
    IF effective_limit IS NULL AND owner_type IN ('authenticated','anonymous')
       AND (SELECT enabled FROM public.billing_settings WHERE id) THEN
        exempt := true;
    END IF;
    effective_limit := coalesce(effective_limit, 10);
    IF owner_type = 'authenticated' THEN
        exempt := coalesce(exempt, false) OR EXISTS (
            SELECT 1 FROM auth.users u JOIN public.generation_daily_email_exemptions e
                ON lower(u.email) = e.email
            WHERE u.id::text = owner_id AND u.email_confirmed_at IS NOT NULL
                AND NOT coalesce(u.is_anonymous, false)
        );
    END IF;
    INSERT INTO public.generation_daily_usage (user_id, user_type, usage_day, attempts)
    VALUES (owner_id, owner_type, today, 1)
    ON CONFLICT (user_id, user_type, usage_day) DO UPDATE
    SET attempts = generation_daily_usage.attempts + 1
    WHERE coalesce(exempt, false) OR generation_daily_usage.attempts < effective_limit
    RETURNING attempts INTO admitted;
    IF admitted IS NULL THEN
        RAISE EXCEPTION 'BB_GENERATION_DAILY_LIMIT:%', effective_limit USING ERRCODE = 'P0001';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_daily_generation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_daily_generation(text, text) TO service_role;

NOTIFY pgrst,'reload schema';
