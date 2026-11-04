-- Imported models and manual edits share the generations table but should never send ready mail.
CREATE FUNCTION public.generation_can_send_ready_email(endpoint text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(endpoint IN ('llmToBricks','novaToBricks','textToBricks','imageToBricks','promptEditModel'), false);
$$;
REVOKE ALL ON FUNCTION public.generation_can_send_ready_email(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.register_generation_completion_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.user_type = 'authenticated' AND public.generation_can_send_ready_email(NEW.endpoint) THEN
    SELECT lower(u.email) INTO NEW.notification_email FROM auth.users u
      WHERE u.id::text = NEW.user_id AND u.email_confirmed_at IS NOT NULL;
    IF NEW.notification_email IS NOT NULL THEN
      NEW.notification_origin := coalesce(nullif(NEW.notification_origin, ''), 'https://brickbuilder.ai');
      NEW.notification_requested_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_generation_completion_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'completed' AND NEW.notification_email IS NOT NULL
    AND public.generation_can_send_ready_email(NEW.endpoint) THEN
    INSERT INTO public.generation_email_outbox(generation_id,email,origin,title)
    VALUES (NEW.id,NEW.notification_email,NEW.notification_origin,
      left(coalesce(nullif(NEW.name,''),'Your brick model'),120))
    ON CONFLICT (generation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.subscribe_generation_email(p_id uuid,p_email text,p_origin text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE existing public.generations;
BEGIN
  SELECT * INTO existing FROM public.generations WHERE id=p_id FOR UPDATE;
  IF existing.id IS NULL OR existing.status IN ('failed','cancelled')
    OR NOT public.generation_can_send_ready_email(existing.endpoint) THEN RETURN false; END IF;
  IF existing.notification_email IS NOT NULL THEN RETURN true; END IF;
  UPDATE public.generations SET notification_email=p_email,notification_origin=p_origin,
    notification_requested_at=now() WHERE id=p_id;
  RETURN true;
END $$;

UPDATE public.generation_email_outbox AS outbox SET state='failed'
FROM public.generations AS generation
WHERE generation.id=outbox.generation_id AND outbox.state IN ('pending','sending')
  AND NOT public.generation_can_send_ready_email(generation.endpoint);

UPDATE public.generations
SET notification_email=NULL, notification_origin=NULL, notification_requested_at=NULL
WHERE notification_email IS NOT NULL AND NOT public.generation_can_send_ready_email(endpoint);

NOTIFY pgrst, 'reload schema';
