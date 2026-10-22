CREATE TABLE public.generation_daily_email_exemptions (
    email text PRIMARY KEY CHECK (email = lower(email))
);
ALTER TABLE public.generation_daily_email_exemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_daily_email_exemptions FROM PUBLIC, anon, authenticated;
ALTER TABLE public.generation_daily_limit_overrides ADD COLUMN unlimited boolean NOT NULL DEFAULT false;
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
