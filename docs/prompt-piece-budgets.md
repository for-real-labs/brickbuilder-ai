# Prompt piece budgets

Both Basic bricks and All parts use the shared prompt_parts_limit parser before
generation starts. This uses no model call. The reusable PARTS_BUDGET_GUIDANCE
instruction is included in their existing generation conversation.

- “Use 100 pieces”, “using 100 bricks”, and “with only 100 parts” set a maximum of
  100. The original prompt remains the target; this is a ceiling, not a guarantee
  that every piece will be used.
- “Under 100 pieces”, “fewer than 100 parts”, and “below 100 bricks” set 99.
- “At most”, “no more than”, “maximum”, and “100 pieces or fewer” are inclusive.
- Digits, comma-separated numbers, and spelled-out numbers are accepted.
- Minimums, negations, dimensions, currency, set numbers, and per-component
  quantities do not become total-part budgets.
- Multiple recognized budgets and the generation setting use the strictest cap.
  Edits may tighten a saved cap but cannot increase it.
- The resolved cap is saved as generations.max_parts and goes through the same
  Basic bricks final validation and Nova catalog configuration as the settings
  control. Inventory part/color quantities remain separate mandatory limits.

This parser intentionally recognizes explicit quantity phrases. Unrecognized or
ambiguous phrasing remains part of the normal design prompt; it does not trigger
a separate reasoning/classification request.
