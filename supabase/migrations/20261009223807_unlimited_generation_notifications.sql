-- Owners may opt in to a completion email for every build, without a daily cap.
-- The row lock and outbox primary key still prevent duplicate messages.
CREATE OR REPLACE FUNCTION public.subscribe_generation_email(p_id uuid,p_email text,p_origin text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE existing public.generations;
BEGIN
  SELECT * INTO existing FROM public.generations WHERE id=p_id FOR UPDATE;
  IF existing.id IS NULL OR existing.status IN ('failed','cancelled') THEN RETURN false; END IF;
  IF existing.notification_email IS NOT NULL THEN RETURN true; END IF;
  UPDATE public.generations SET notification_email=p_email,notification_origin=p_origin,
    notification_requested_at=now() WHERE id=p_id;
  RETURN true;
END $$;

NOTIFY pgrst,'reload schema';
