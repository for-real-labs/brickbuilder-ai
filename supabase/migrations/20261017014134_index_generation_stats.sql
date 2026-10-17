-- The landing page polls these aggregates every 30 seconds. Keep both count(*)
-- and sum(brick_count) on a small covering index instead of scanning model rows.
-- Include null brick counts: those generations still contribute to count(*).
CREATE INDEX IF NOT EXISTS generations_stats_brick_count_idx
  ON public.generations (brick_count);
