-- Operator-managed overrides; no account identifiers are stored in source control.
CREATE TABLE IF NOT EXISTS public.generation_daily_limit_overrides (
    user_id text NOT NULL,
    user_type text NOT NULL CHECK (user_type = 'authenticated'),
    daily_limit integer NOT NULL CHECK (daily_limit BETWEEN 1 AND 30),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, user_type)
);
ALTER TABLE public.generation_daily_limit_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_daily_limit_overrides FROM PUBLIC, anon, authenticated;
-- Lower the quota without resetting any existing usage counters.
CREATE OR REPLACE FUNCTION public.reserve_daily_generation(owner_id text, owner_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
    admitted integer;
    effective_limit integer;
BEGIN
    SELECT daily_limit INTO effective_limit FROM public.generation_daily_limit_overrides
    WHERE user_id = owner_id AND user_type = owner_type;
    effective_limit := coalesce(effective_limit, 30);
    INSERT INTO public.generation_daily_usage (user_id, user_type, usage_day, attempts)
    VALUES (owner_id, owner_type, today, 1)
    ON CONFLICT (user_id, user_type, usage_day) DO UPDATE
    SET attempts = generation_daily_usage.attempts + 1
    WHERE generation_daily_usage.attempts < effective_limit
    RETURNING attempts INTO admitted;
    IF admitted IS NULL THEN
        RAISE EXCEPTION 'BB_GENERATION_DAILY_LIMIT:%', effective_limit USING ERRCODE = 'P0001';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_daily_generation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_daily_generation(text, text) TO service_role;
