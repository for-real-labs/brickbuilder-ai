-- A server-timestamped visit proves that the referred account was created after
-- opening a shared link. Receipts are opaque; the link itself uses the sender ID.
CREATE TABLE public.referral_visits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 referrer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX referral_visits_referrer ON public.referral_visits(referrer_id);
CREATE TABLE public.referral_rewards (
 referred_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 referrer_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_rewards_referrer ON public.referral_rewards(referrer_id);
ALTER TABLE public.referral_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.referral_visits,public.referral_rewards FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.referral_visits,public.referral_rewards TO service_role;
ALTER TABLE public.billing_credit_history DROP CONSTRAINT billing_credit_history_kind_check;
ALTER TABLE public.billing_credit_history ADD CONSTRAINT billing_credit_history_kind_check
 CHECK(kind IN ('welcome','monthly','upgrade','generation','refund','purchase','purchase_refund','referral'));

CREATE FUNCTION public.begin_referral_visit(p_referrer uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_referrer AND email_confirmed_at IS NOT NULL
   AND NOT coalesce(is_anonymous,false)) THEN RETURN NULL; END IF;
 INSERT INTO public.referral_visits(referrer_id) VALUES(p_referrer) RETURNING id INTO receipt;
 RETURN receipt;
END $$;

-- Internal helper: never accept an arbitrary rewarded user from public clients.
CREATE FUNCTION public.award_account_referral(p_user uuid,p_visit uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE visit public.referral_visits; newcomer auth.users; admitted uuid;
BEGIN
 SELECT * INTO visit FROM public.referral_visits WHERE id=p_visit;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO newcomer FROM auth.users WHERE id=p_user;
 IF NOT FOUND OR newcomer.email_confirmed_at IS NULL OR coalesce(newcomer.is_anonymous,false)
   OR newcomer.id=visit.referrer_id OR newcomer.created_at<visit.created_at
   OR newcomer.created_at>visit.created_at+interval '30 days'
   OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=visit.referrer_id AND email_confirmed_at IS NOT NULL
     AND NOT coalesce(is_anonymous,false)) THEN RETURN false; END IF;
 INSERT INTO public.referral_rewards(referred_user_id,referrer_id) VALUES(p_user,visit.referrer_id)
 ON CONFLICT(referred_user_id) DO NOTHING RETURNING referred_user_id INTO admitted;
 IF admitted IS NULL THEN RETURN false; END IF;
 PERFORM public.billing_account(visit.referrer_id,true);
 -- The existing non-expiring purchased-credit bucket supports every build type.
 UPDATE public.billing_accounts SET apple_remaining=apple_remaining+300
 WHERE user_id=visit.referrer_id AND livemode=true;
 INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start,apple_amount)
 VALUES(visit.referrer_id,true,'referral:'||p_user,'referral',300,'apple',now(),300);
 RETURN true;
END $$;

CREATE FUNCTION public.claim_account_referral(p_visit uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT public.award_account_referral(auth.uid(),p_visit);
$$;

-- Email/password and OTP signups carry the receipt across devices. Only account
-- creation or first email confirmation can trigger an award, never metadata edits.
CREATE FUNCTION public.confirm_account_referral() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt text;
BEGIN
 IF NEW.email_confirmed_at IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.email_confirmed_at IS NOT NULL THEN RETURN NEW; END IF;
 END IF;
 receipt:=NEW.raw_user_meta_data->>'referral_visit';
 IF receipt ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   PERFORM public.award_account_referral(NEW.id,receipt::uuid);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER on_account_referral_confirmed AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
 FOR EACH ROW EXECUTE FUNCTION public.confirm_account_referral();
REVOKE ALL ON FUNCTION public.begin_referral_visit(uuid),public.award_account_referral(uuid,uuid),
 public.claim_account_referral(uuid),public.confirm_account_referral() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_referral_visit(uuid) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_account_referral(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
