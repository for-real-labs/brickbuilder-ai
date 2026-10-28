-- Only service-role code may erase an authenticated account. Keep a UUID-only
-- tombstone to stop still-valid JWTs and late jobs from recreating deleted data.
CREATE TABLE public.account_deletions (
 user_id uuid PRIMARY KEY, requested_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.account_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletions FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.account_deletions TO service_role;

CREATE FUNCTION public.account_deletion_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('account-delete:'||NEW.user_id,0));
 IF EXISTS(SELECT 1 FROM account_deletions WHERE user_id::text=NEW.user_id) THEN
  RAISE EXCEPTION 'ACCOUNT_DELETION_IN_PROGRESS';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_deletion_generation_guard BEFORE INSERT ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.account_deletion_generation_guard();

CREATE FUNCTION public.account_deletion_prepare(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('account-delete:'||p_user_id::text,0));
 IF EXISTS(SELECT 1 FROM generations WHERE user_id=p_user_id::text
  AND status NOT IN ('completed','failed','cancelled')) THEN
  RAISE EXCEPTION 'ACCOUNT_HAS_ACTIVE_BUILDS';
 END IF;
 INSERT INTO account_deletions(user_id) VALUES(p_user_id) ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION public.account_deletion_files(p_user_id uuid)
RETURNS TABLE(bucket_id text,name text) LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT o.bucket_id,o.name FROM storage.objects o
 WHERE EXISTS(SELECT 1 FROM account_deletions WHERE user_id=p_user_id)
 AND NOT (o.bucket_id IN ('generations','generation-output') AND EXISTS(
   SELECT 1 FROM generations g JOIN generations purchased
    ON coalesce(purchased.generation_id,purchased.id)=coalesce(g.generation_id,g.id)
    JOIN orders ord ON ord.generation_id=purchased.id
   WHERE (o.name LIKE 'generations/'||g.generation_id::text||'/%'
     OR o.name LIKE g.generation_id::text||'/%'
     OR o.name LIKE 'generations/'||g.id::text||'/%'
     OR o.name LIKE g.id::text||'/%')))
 AND (o.owner_id=p_user_id::text OR
  (o.bucket_id IN ('generations','generation-output') AND EXISTS(
   SELECT 1 FROM generations g WHERE g.user_id=p_user_id::text
    AND NOT EXISTS(SELECT 1 FROM orders ord JOIN generations purchased ON purchased.id=ord.generation_id
      WHERE coalesce(purchased.generation_id,purchased.id)=coalesce(g.generation_id,g.id))
    AND (o.name LIKE 'generations/'||g.generation_id::text||'/%'
      OR o.name LIKE g.generation_id::text||'/%'
      OR o.name LIKE 'generations/'||g.id::text||'/%'
      OR o.name LIKE g.id::text||'/%')))
  OR (o.bucket_id='change-request-images' AND EXISTS(
    SELECT 1 FROM change_requests c WHERE c.user_id=p_user_id AND o.name LIKE c.id::text||'/%')))
 LIMIT 500;
$$;

CREATE FUNCTION public.account_deletion_data(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE account_email text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=p_user_id) THEN
  RAISE EXCEPTION 'ACCOUNT_DELETION_NOT_REQUESTED';
 END IF;
 SELECT email INTO account_email FROM auth.users WHERE id=p_user_id;
 DELETE FROM generation_email_outbox WHERE generation_id IN
  (SELECT id FROM generations WHERE user_id=p_user_id::text) OR lower(email)=lower(account_email);
 -- Physical-order records and required model files are retained for fulfillment
 -- and financial records, but are no longer public or attached to a user account.
 DELETE FROM generations g WHERE user_id=p_user_id::text
  AND NOT EXISTS(SELECT 1 FROM orders o JOIN generations purchased ON purchased.id=o.generation_id
    WHERE coalesce(purchased.generation_id,purchased.id)=coalesce(g.generation_id,g.id));
 -- Remaining owned files are order artifacts excluded from file erasure.
 -- Release Auth ownership so the Auth Admin API can remove the user.
 UPDATE storage.objects SET owner=NULL,owner_id=NULL WHERE owner_id=p_user_id::text;
 UPDATE generations SET user_id='deleted-account',is_community=false,
  notification_email=NULL,notification_origin=NULL WHERE user_id=p_user_id::text;
 DELETE FROM generation_daily_usage WHERE user_id=p_user_id::text;
 DELETE FROM generation_daily_limit_overrides WHERE user_id=p_user_id::text;
 DELETE FROM generation_guest_usage WHERE user_id=p_user_id::text;
 DELETE FROM generation_daily_email_exemptions WHERE lower(email)=lower(account_email);
 DELETE FROM change_request_email_access WHERE lower(email)=lower(account_email);
 DELETE FROM waitlist_emails WHERE lower(email)=lower(account_email);
 DELETE FROM billing_credit_purchases WHERE user_id=p_user_id;
 DELETE FROM user_profiles WHERE id=p_user_id;
 -- Other account tables cascade from auth.users via the Auth Admin API.
END $$;
REVOKE ALL ON FUNCTION public.account_deletion_generation_guard(),public.account_deletion_prepare(uuid),
 public.account_deletion_files(uuid),public.account_deletion_data(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_prepare(uuid),public.account_deletion_files(uuid),
 public.account_deletion_data(uuid) TO service_role;
