-- Lower the quota without resetting any existing usage counters.
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
    WHERE generation_daily_usage.attempts < 30
    RETURNING attempts INTO admitted;
    IF admitted IS NULL THEN
        RAISE EXCEPTION 'BB_GENERATION_DAILY_LIMIT' USING ERRCODE = 'P0001';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_daily_generation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_daily_generation(text, text) TO service_role;
