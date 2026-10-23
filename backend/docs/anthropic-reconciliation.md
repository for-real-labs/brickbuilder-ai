# Anthropic billing reconciliation

The production API refreshes the previous seven complete UTC days every hour.
Configure `ANTHROPIC_ADMIN_KEY` and `ANTHROPIC_USAGE_WORKSPACE_ID` on the backend
service only. Use the workspace that contains BrickBuilder's generation API keys;
if that workspace is shared, its totals also contain other applications. Never put
an Admin key in the frontend or a preview environment. Missing credentials disable
this worker with a startup warning; a normal workspace inference key is insufficient.

Apply `20261022030000_anthropic_usage_reconciliation.sql` before deployment.
Private `anthropic_daily_reconciliation` rows contain provider usage/cost breakdowns,
normalized token totals, local recorded totals, diagnostic gaps, and `observed_at`.
Only service-role access is granted. Query freshness alongside costs; failed syncs
retain the prior snapshots. Pagination completes before writing, and daily upserts
avoid duplicate counting. Missing provider buckets remain null, not zero.

Cost API amounts are cents and are converted to USD. Local costs include only
Claude calls. Local input token counts include uncached, cache-read, and cache-write
tokens, matching the normalized provider total. Failed and cancelled jobs are included.

These are diagnostic comparisons, not exact attribution: provider billing timing
can differ from a generation's creation date; jobs can cross midnight; retained rows
can be deleted; late usage can revise totals; shared workspaces include nonproduction
traffic; server-tool charges are not local LLM token estimates; Priority Tier costs
are excluded from Anthropic's cost endpoint. Missing local usage is explicitly counted.
Never distribute the gap across individual generations or call it confirmed lost usage.
Reports cover completed days, not live spending today. Each refresh revisits seven
days for late data; older stored snapshots are retained but not automatically revised.

References:
https://platform.claude.com/docs/en/manage-claude/usage-cost-api
