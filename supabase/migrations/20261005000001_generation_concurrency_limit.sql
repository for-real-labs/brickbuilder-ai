-- Serialize admission per owner across API workers and both LLM modes.
CREATE OR REPLACE FUNCTION public.enforce_generation_concurrency_limit()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.endpoint IN ('llmToBricks', 'novaToBricks')
       AND NEW.status IN ('queued', 'started', 'processing', 'ldr_processing', 'resizing') THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
            'generation-limit:' || NEW.user_type || ':' || NEW.user_id, 0));
        IF (SELECT count(*) FROM public.generations
            WHERE user_id = NEW.user_id AND user_type = NEW.user_type
              AND status IN ('queued', 'started', 'processing', 'ldr_processing', 'resizing')) >= 10 THEN
            RAISE EXCEPTION 'BB_GENERATION_CONCURRENCY_LIMIT' USING ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_generation_concurrency_limit() FROM PUBLIC;
DROP TRIGGER IF EXISTS generations_concurrency_limit ON public.generations;
CREATE TRIGGER generations_concurrency_limit BEFORE INSERT ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.enforce_generation_concurrency_limit();

CREATE INDEX IF NOT EXISTS generations_active_owner_idx
ON public.generations (user_id, user_type)
WHERE status IN ('queued', 'started', 'processing', 'ldr_processing', 'resizing');
