-- Register completion delivery atomically, including every new edit revision.
CREATE OR REPLACE FUNCTION public.register_generation_completion_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.user_type = 'authenticated' THEN
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
REVOKE ALL ON FUNCTION public.register_generation_completion_email() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER register_generation_completion_email BEFORE INSERT ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.register_generation_completion_email();
NOTIFY pgrst, 'reload schema';
