-- Keep legacy tracking for audit; its IP+User-Agent hashes (and any session keys)
-- cannot be converted to true network identities. Never reinterpret old keys.
CREATE TABLE IF NOT EXISTS public.anonymous_users (
    id bigserial PRIMARY KEY,
    ip_hash text NOT NULL UNIQUE,
    call_count integer NOT NULL DEFAULT 0,
    first_call timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.anonymous_users ALTER COLUMN ip_hash TYPE text;
ALTER TABLE public.anonymous_users ADD COLUMN IF NOT EXISTS identity_type text NOT NULL DEFAULT 'legacy';
CREATE UNIQUE INDEX IF NOT EXISTS anonymous_users_identity_key ON public.anonymous_users(ip_hash);
ALTER TABLE public.anonymous_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.anonymous_users FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.anonymous_users IS
    'Guest network trial counters: identity_type=ip_v1 is HMAC IPv4 or IPv6 /64, not browser ownership. Legacy records are retained but not enforced.';
COMMENT ON COLUMN public.anonymous_users.ip_hash IS
    'Versioned server-derived network hash. Legacy IP+User-Agent hashes cannot be mapped to current IPs.';
COMMENT ON COLUMN public.anonymous_users.call_count IS
    'For ip_v1: lifetime admitted generation attempts, including failed/cancelled jobs. Updated atomically at admission.';

-- Transport-only admission field; the trigger clears it before storing the row.
ALTER TABLE public.generations ADD COLUMN IF NOT EXISTS guest_ip_hash text;
COMMENT ON COLUMN public.generations.guest_ip_hash IS
    'Admission-only server input; cleared by the guest trial trigger before storage. Not ownership proof.';

CREATE OR REPLACE FUNCTION public.reserve_guest_ip_generation(network_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE admitted integer;
BEGIN
    IF network_hash IS NULL OR network_hash !~ '^ip_v1_[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'BB_GENERATION_GUEST_IP_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.anonymous_users (ip_hash, identity_type, call_count, first_call)
    VALUES (network_hash, 'ip_v1', 1, now())
    ON CONFLICT (ip_hash) DO UPDATE
    SET call_count = anonymous_users.call_count + 1, updated_at = now()
    WHERE anonymous_users.identity_type = 'ip_v1' AND anonymous_users.call_count < 3
    RETURNING call_count INTO admitted;
    IF admitted IS NULL THEN
        RAISE EXCEPTION 'BB_GENERATION_GUEST_LIMIT' USING ERRCODE = 'P0001';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_guest_ip_generation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_guest_ip_generation(text) TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_generation_guest_limit()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.user_type = 'anonymous' THEN
        -- Both counters and the generation commit together, or all roll back.
        PERFORM public.reserve_guest_generation(NEW.user_id, NEW.user_type);
        PERFORM public.reserve_guest_ip_generation(NEW.guest_ip_hash);
    END IF;
    NEW.guest_ip_hash := NULL;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_generation_guest_limit() FROM PUBLIC;
NOTIFY pgrst, 'reload schema';
