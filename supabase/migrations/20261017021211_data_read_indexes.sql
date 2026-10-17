-- The public landing page needs the first few popular models, not a scan and
-- sort of every private generation. Only community rows belong in this index.
CREATE INDEX IF NOT EXISTS generations_community_top_idx
  ON public.generations (like_count DESC, created_at DESC)
  WHERE is_community = true;

-- Notification history reads the most recent completions for one owner.
CREATE INDEX IF NOT EXISTS generations_completed_owner_updated_idx
  ON public.generations (user_id, user_type, updated_at DESC)
  WHERE status = 'completed';
