alter table public.generations
  add column if not exists input_tokens bigint check (input_tokens >= 0),
  add column if not exists output_tokens bigint check (output_tokens >= 0),
  add column if not exists tokens_used bigint check (tokens_used >= 0),
  add column if not exists estimated_cost_usd numeric(18, 8)
    check (estimated_cost_usd >= 0 and estimated_cost_usd < 'Infinity'::numeric),
  add column if not exists ai_usage jsonb,
  add column if not exists example_edit_prompt text
    check (char_length(example_edit_prompt) between 1 and 200);

comment on column public.generations.tokens_used is
  'Sum of reported LLM input (including cached input) and output tokens for this revision. Historical/unreported usage stays null.';
comment on column public.generations.estimated_cost_usd is
  'Estimated USD for reported LLM calls at standard API token prices, including title/edit suggestion. Excludes hosting, non-LLM image/3D charges, taxes and subscription discounts; not an invoice.';
comment on column public.generations.ai_usage is
  'Per-call model, token/cache breakdown and estimated USD; no prompts, emails or credentials. Scope: reported_llm_usage.';
comment on column public.generations.example_edit_prompt is
  'A subject-specific example returned by the model title LLM, shown as the refinement placeholder.';

-- Keep the public view's existing column set and grants: usage is server-only.
notify pgrst, 'reload schema';
