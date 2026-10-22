CREATE TABLE public.anthropic_daily_reconciliation (
    workspace_id text NOT NULL,
    usage_day date NOT NULL,
    observed_at timestamptz NOT NULL,
    provider_usage jsonb,
    provider_cost_items jsonb,
    provider_token_totals jsonb,
    diagnostic_token_gaps jsonb,
    provider_cost_usd numeric,
    local_usage jsonb NOT NULL,
    diagnostic_cost_gap_usd numeric,
    comparison_basis text NOT NULL,
    PRIMARY KEY (workspace_id, usage_day)
);
ALTER TABLE public.anthropic_daily_reconciliation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.anthropic_daily_reconciliation FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.anthropic_daily_reconciliation TO service_role;

CREATE FUNCTION public.anthropic_local_usage_summary(start_at timestamptz, end_at timestamptz)
RETURNS TABLE(usage_day date, generations bigint, missing_usage bigint,
    estimated_claude_cost_usd numeric, input_tokens numeric, output_tokens numeric,
    cache_read_input_tokens numeric, cache_creation_input_tokens numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF start_at IS NULL OR end_at IS NULL OR end_at <= start_at OR end_at-start_at > interval '31 days' THEN
        RAISE EXCEPTION 'Invalid reconciliation window';
    END IF;
    RETURN QUERY
    SELECT (g.created_at AT TIME ZONE 'UTC')::date, count(*),
        count(*) FILTER (WHERE g.ai_usage IS NULL OR g.ai_usage->'calls' IS NULL OR g.ai_usage->'calls' = '[]'::jsonb),
        coalesce(sum(c.cost),0), coalesce(sum(c.input),0), coalesce(sum(c.output),0),
        coalesce(sum(c.cache_read),0), coalesce(sum(c.cache_creation),0)
    FROM public.generations g
    LEFT JOIN LATERAL (
        SELECT sum((v->>'estimated_cost_usd')::numeric) cost,
            sum((v->>'input_tokens')::numeric) input, sum((v->>'output_tokens')::numeric) output,
            sum((v->>'cache_read_tokens')::numeric) cache_read,
            sum((v->>'cache_write_tokens')::numeric) cache_creation
        FROM jsonb_array_elements(g.ai_usage->'calls') v
        WHERE v->>'model' LIKE '%claude%'
    ) c ON true
    WHERE g.created_at >= start_at AND g.created_at < end_at
    GROUP BY 1 ORDER BY 1;
END;
$$;
REVOKE ALL ON FUNCTION public.anthropic_local_usage_summary(timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anthropic_local_usage_summary(timestamptz,timestamptz) TO service_role;
