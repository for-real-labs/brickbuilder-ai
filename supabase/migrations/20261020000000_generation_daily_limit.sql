-- Every new generation/revision consumes one attempt, regardless of outcome.
CREATE TABLE IF NOT EXISTS public.generation_daily_usage (
    user_id text NOT NULL,
    user_type text NOT NULL,
    usage_day date NOT NULL,
    attempts integer NOT NULL CHECK (attempts >= 0),
    PRIMARY KEY (user_id, user_type, usage_day)
);
ALTER TABLE public.generation_daily_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_daily_usage FROM PUBLIC, anon, authenticated;
-- Count today's existing attempts before enabling the limit. Serializing writes
-- makes the backfill and trigger installation one atomic operation.
LOCK TABLE public.generations IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO public.generation_daily_usage (user_id, user_type, usage_day, attempts)
SELECT user_id, user_type, (created_at AT TIME ZONE 'UTC')::date, count(*)
FROM public.generations
WHERE created_at >= ((statement_timestamp() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC')
  AND user_id IS NOT NULL AND user_type IS NOT NULL
GROUP BY user_id, user_type, (created_at AT TIME ZONE 'UTC')::date
ON CONFLICT (user_id, user_type, usage_day) DO NOTHING;
CREATE OR REPLACE FUNCTION public.reserve_daily_generation(owner_id text, owner_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
    admitted integer;
BEGIN
    INSERT INTO public.generation_daily_usage (user_id, user_type, usage_day, attempts)
    VALUES (owner_id, owner_type, today, 1)
    ON CONFLICT (user_id, user_type, usage_day) DO UPDATE
    SET attempts = generation_daily_usage.attempts + 1
    WHERE generation_daily_usage.attempts < 200
    RETURNING attempts INTO admitted;
    IF admitted IS NULL THEN
        RAISE EXCEPTION 'BB_GENERATION_DAILY_LIMIT' USING ERRCODE = 'P0001';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_daily_generation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_daily_generation(text, text) TO service_role;
CREATE OR REPLACE FUNCTION public.enforce_generation_daily_limit()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    PERFORM public.reserve_daily_generation(NEW.user_id, NEW.user_type);
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS generations_daily_limit ON public.generations;
CREATE TRIGGER generations_daily_limit BEFORE INSERT ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.enforce_generation_daily_limit();
REVOKE ALL ON FUNCTION public.enforce_generation_daily_limit() FROM PUBLIC;
