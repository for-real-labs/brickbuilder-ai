-- Freeze the completed model preview on the first delivery attempt, so retries
-- retain the same Resend idempotency payload even if the model is later edited.
ALTER TABLE public.generation_email_outbox ADD COLUMN preview_image_url text;

CREATE OR REPLACE FUNCTION public.claim_generation_email(p_origin text) RETURNS SETOF public.generation_email_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.generation_email_outbox SET state='failed'
    WHERE origin=p_origin AND state IN ('pending','sending') AND available_at <= now()
      AND (attempts >= 6 OR first_attempt_at <= now()-interval '20 hours');
  RETURN QUERY UPDATE public.generation_email_outbox AS queued SET state='sending',attempts=queued.attempts+1,
    preview_image_url=CASE WHEN queued.first_attempt_at IS NULL THEN
      (SELECT g.preview_image_url FROM public.generations g WHERE g.id=queued.generation_id)
      ELSE queued.preview_image_url END,
    first_attempt_at=coalesce(queued.first_attempt_at,now()),lease_id=gen_random_uuid(),available_at=now()+interval '2 minutes'
  WHERE queued.generation_id=(SELECT pending.generation_id FROM public.generation_email_outbox pending
    WHERE pending.origin=p_origin AND pending.state IN ('pending','sending') AND pending.available_at <= now()
      AND pending.attempts < 6 AND (pending.first_attempt_at IS NULL OR pending.first_attempt_at > now()-interval '20 hours')
    ORDER BY pending.available_at FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING queued.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_generation_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_generation_email(text) TO service_role;
NOTIFY pgrst,'reload schema';
