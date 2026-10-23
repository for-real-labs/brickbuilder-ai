-- Keys are ciphertext only; the encryption secret is supplied to the API separately.
CREATE TABLE public.user_provider_keys (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK (provider IN ('openai','anthropic')),
 encrypted_key text NOT NULL,
 PRIMARY KEY(user_id,provider)
);
CREATE TABLE public.user_ai_preferences (
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 billing_source text NOT NULL DEFAULT 'brickbuilder' CHECK(billing_source IN ('personal','brickbuilder')),
 skip_confirmation boolean NOT NULL DEFAULT false
);
ALTER TABLE public.user_provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_ai_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_provider_keys,public.user_ai_preferences FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.user_provider_keys,public.user_ai_preferences TO service_role;
ALTER TABLE public.generations ADD COLUMN personal_billing boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.guard_personal_billing() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.personal_billing IS DISTINCT FROM OLD.personal_billing THEN
   RAISE EXCEPTION 'Personal billing cannot change after admission';
 END IF;
 IF NEW.personal_billing THEN
   IF current_user NOT IN ('service_role','postgres','supabase_admin') OR NEW.user_type<>'authenticated'
      OR NEW.endpoint NOT IN ('llmToBricks','novaToBricks') THEN
     RAISE EXCEPTION 'Invalid personal billing admission';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generations_00_personal_billing BEFORE INSERT OR UPDATE ON public.generations
 FOR EACH ROW EXECUTE FUNCTION public.guard_personal_billing();
REVOKE ALL ON FUNCTION public.guard_personal_billing() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_generation_daily_limit()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NOT NEW.personal_billing THEN PERFORM public.reserve_daily_generation(NEW.user_id,NEW.user_type); END IF;
 RETURN NEW;
END $$;

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
 IF NEW.user_type='anonymous' THEN
   IF cost<>1 THEN RAISE EXCEPTION 'BB_SIGN_IN_REQUIRED'; END IF;
 ELSIF NEW.user_id<>'developer' THEN
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

