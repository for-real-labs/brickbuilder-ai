-- Opt-in, single-message completion mail. Email addresses are server-only.
ALTER TABLE public.generations ADD COLUMN notification_email text;
ALTER TABLE public.generations ADD COLUMN notification_origin text;
ALTER TABLE public.generations ADD COLUMN notification_requested_at timestamptz;
CREATE INDEX generations_notification_recipient ON public.generations(notification_email,notification_requested_at)
  WHERE notification_email IS NOT NULL;

-- Table-level grants would otherwise expose new columns through REST.
DO $$
DECLARE cols text; role_name text; privilege_name text;
BEGIN
  SELECT string_agg(quote_ident(attname), ',') INTO cols FROM pg_attribute
  WHERE attrelid = 'public.generations'::regclass AND attnum > 0 AND NOT attisdropped
    AND attname NOT IN ('notification_email','notification_origin','notification_requested_at');
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE'] LOOP
      IF has_table_privilege(role_name, 'public.generations', privilege_name) THEN
        EXECUTE format('REVOKE %s ON public.generations FROM %I', privilege_name, role_name);
        EXECUTE format('GRANT %s (%s) ON public.generations TO %I', privilege_name, cols, role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;

CREATE TABLE public.generation_email_outbox (
  generation_id uuid PRIMARY KEY REFERENCES public.generations(id) ON DELETE CASCADE,
  email text NOT NULL,
  origin text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  first_attempt_at timestamptz,
  lease_id uuid,
  provider_id text,
  sent_at timestamptz
);
ALTER TABLE public.generation_email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_email_outbox FROM anon, authenticated;
GRANT ALL ON public.generation_email_outbox TO service_role;
CREATE INDEX generation_email_outbox_pending ON public.generation_email_outbox(origin, available_at) WHERE state IN ('pending','sending');

CREATE FUNCTION public.queue_generation_completion_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'completed' AND NEW.notification_email IS NOT NULL THEN
    INSERT INTO public.generation_email_outbox(generation_id,email,origin,title)
    VALUES (NEW.id,NEW.notification_email,NEW.notification_origin,
      left(coalesce(nullif(NEW.name,''),'Your brick model'),120))
    ON CONFLICT (generation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER generation_completion_email AFTER UPDATE OF status,notification_email ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.queue_generation_completion_email();

CREATE FUNCTION public.subscribe_generation_email(p_id uuid,p_email text,p_origin text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE existing public.generations;
BEGIN
  SELECT * INTO existing FROM public.generations WHERE id=p_id FOR UPDATE;
  IF existing.id IS NULL OR existing.status IN ('failed','cancelled') THEN RETURN false; END IF;
  IF existing.notification_email IS NOT NULL THEN RETURN true; END IF;
  IF (SELECT count(*) FROM public.generations WHERE notification_email=p_email
       AND notification_requested_at > now()-interval '1 day') >= 3 THEN
    RAISE EXCEPTION 'notification recipient limit' USING ERRCODE='P0001';
  END IF;
  -- Serialize recipient limits across different generations.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_email,19));
  IF (SELECT count(*) FROM public.generations WHERE notification_email=p_email
       AND notification_requested_at > now()-interval '1 day') >= 3 THEN
    RAISE EXCEPTION 'notification recipient limit' USING ERRCODE='P0001';
  END IF;
  UPDATE public.generations SET notification_email=p_email,notification_origin=p_origin,
    notification_requested_at=now() WHERE id=p_id;
  RETURN true;
END $$;

CREATE FUNCTION public.notification_profile_id(p_email text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public,auth AS $$
  SELECT id FROM auth.users WHERE lower(email)=lower(p_email) LIMIT 1;
$$;

CREATE FUNCTION public.claim_generation_email(p_origin text) RETURNS SETOF public.generation_email_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Resend idempotency expires after 24 hours. Never redeliver beyond that window.
  UPDATE public.generation_email_outbox SET state='failed'
    WHERE origin=p_origin AND state IN ('pending','sending') AND available_at <= now()
      AND (attempts >= 6 OR first_attempt_at <= now()-interval '20 hours');
  RETURN QUERY UPDATE public.generation_email_outbox SET state='sending',attempts=attempts+1,
    first_attempt_at=coalesce(first_attempt_at,now()),lease_id=gen_random_uuid(),available_at=now()+interval '2 minutes'
  WHERE generation_id=(SELECT generation_id FROM public.generation_email_outbox
    WHERE origin=p_origin AND state IN ('pending','sending') AND available_at <= now()
      AND attempts < 6 AND (first_attempt_at IS NULL OR first_attempt_at > now()-interval '20 hours')
    ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_generation_completion_email() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscribe_generation_email(uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_profile_id(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_generation_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.subscribe_generation_email(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.notification_profile_id(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_generation_email(text) TO service_role;
NOTIFY pgrst,'reload schema';
