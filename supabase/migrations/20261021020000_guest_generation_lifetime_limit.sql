-- Guest trials never reset. Keep counters separate from mutable model ownership.
CREATE TABLE IF NOT EXISTS public.generation_guest_usage (
    user_id text PRIMARY KEY,
    attempts bigint NOT NULL CHECK (attempts >= 0)
);
ALTER TABLE public.generation_guest_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_guest_usage FROM PUBLIC, anon, authenticated;

LOCK TABLE public.generations IN SHARE ROW EXCLUSIVE MODE;
-- Daily counters retain attempts whose generations were deleted or claimed.
-- Take the larger historical total, not their sum (which would double-count).
INSERT INTO public.generation_guest_usage (user_id, attempts)
SELECT user_id, max(attempts) FROM (
    SELECT user_id, count(*) AS attempts FROM public.generations
    WHERE user_type = 'anonymous' AND user_id IS NOT NULL GROUP BY user_id
    UNION ALL
    SELECT user_id, sum(attempts) AS attempts FROM public.generation_daily_usage
    WHERE user_type = 'anonymous' GROUP BY user_id
) history GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE
SET attempts = greatest(generation_guest_usage.attempts, EXCLUDED.attempts);

CREATE OR REPLACE FUNCTION public.reserve_guest_generation(owner_id text, owner_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE admitted bigint;
BEGIN
    IF owner_type IS DISTINCT FROM 'anonymous' THEN RETURN; END IF;
    INSERT INTO public.generation_guest_usage (user_id, attempts) VALUES (owner_id, 1)
    ON CONFLICT (user_id) DO UPDATE SET attempts = generation_guest_usage.attempts + 1
    WHERE generation_guest_usage.attempts < 3
    RETURNING attempts INTO admitted;
    IF admitted IS NULL THEN
        RAISE EXCEPTION 'BB_GENERATION_GUEST_LIMIT' USING ERRCODE = 'P0001';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_guest_generation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_guest_generation(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_generation_guest_limit()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    PERFORM public.reserve_guest_generation(NEW.user_id, NEW.user_type);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_generation_guest_limit() FROM PUBLIC;
-- Run before daily/concurrency admission so exhausted guests see sign-in guidance.
DROP TRIGGER IF EXISTS generations_0_guest_limit ON public.generations;
CREATE TRIGGER generations_0_guest_limit BEFORE INSERT ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.enforce_generation_guest_limit();
