"""A per-generation USD budget shared by direct calls and the Nova runtime."""
from __future__ import annotations

import json
from decimal import Decimal, ROUND_FLOOR

MAX_GENERATION_COST_USD = Decimal('10')
BUDGET_ERROR = 'Generation stopped because it would exceed the $10 AI cost limit.'


class GenerationBudgetExceeded(ValueError):
    def __init__(self):
        super().__init__(BUDGET_ERROR)


# Standard API USD per million tokens, verified 2026-10-05:
# https://developers.openai.com/api/docs/pricing
# https://platform.claude.com/docs/en/about-claude/pricing
# input, output, cache read, 5m cache write, 1h cache write
MODEL_PRICES = {
    'gpt-5.6-sol': ('4', '20', '.4', '5', '8'),
    'gpt-5.6-terra': ('2', '12', '.2', '2.5', '4'),
    'gpt-5.5': ('5', '30', '.5', '6.25', '10'),
    'claude-opus-5-5': ('4', '20', '.2', '5', '8'),
    'claude-opus-5': ('5', '25', '.5', '6.25', '10'),
    'claude-sonnet-5': ('2', '10', '.2', '2.5', '4'),
    'claude-fable-5': ('10', '50', '1', '12.5', '20'),
}


def input_token_bound(payload) -> int:
    """Reserve one token per UTF-8 byte plus framing and bounded image input.

    Base64 size is unrelated to vision tokens. Reserve 32K per image instead.
    This deliberately overestimates text rather than assuming four chars/token.
    """
    def bounded(value):
        if isinstance(value, dict):
            if value.get('type') in {'image', 'input_image', 'image_url'}:
                return 'x' * 32768
            return {key: bounded(item) for key, item in value.items()}
        if isinstance(value, list):
            return [bounded(item) for item in value]
        return value
    return len(json.dumps(bounded(payload), ensure_ascii=False).encode('utf-8')) + 2048


def _tokens(usage: dict, key: str) -> int:
    value = usage.get(key, 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError('Provider returned invalid token usage; generation stopped.')
    return value


class GenerationBudget:
    def __init__(self, model: str):
        self.model = model.split('/')[-1]
        if self.model not in MODEL_PRICES:
            raise ValueError('AI cost limits are unavailable for this model; generation stopped.')
        self.prices = tuple(Decimal(price) for price in MODEL_PRICES[self.model])
        self.spent = Decimal('0')

    def output_limit(self, input_tokens: int, requested: int) -> int:
        # Reserve cache writes at their highest rate and long-context pricing.
        input_price, output_price, _, _, write_price = self.prices
        if self.model.startswith('gpt-') and input_tokens > 272000:
            input_price *= 2
            write_price *= 2
            output_price *= Decimal('1.5')
        reserve = Decimal(input_tokens) * max(input_price, write_price) / 1000000
        available = MAX_GENERATION_COST_USD - self.spent - reserve
        limit = int((available * 1000000 / output_price).to_integral_value(rounding=ROUND_FLOOR))
        if limit < 1:
            raise GenerationBudgetExceeded()
        return min(requested, limit)

    def record_usage(self, usage: dict | None, provider: str) -> None:
        if not isinstance(usage, dict) or not any(k in usage for k in ('input_tokens', 'prompt_tokens')) or not any(k in usage for k in ('output_tokens', 'completion_tokens')):
            raise ValueError('Provider did not report AI cost usage; generation stopped.')
        input_price, output_price, read_price, write5, write1 = self.prices
        if provider == 'anthropic':
            inputs, outputs = _tokens(usage, 'input_tokens'), _tokens(usage, 'output_tokens')
            cached, written = _tokens(usage, 'cache_read_input_tokens'), _tokens(usage, 'cache_creation_input_tokens')
            creation = usage.get('cache_creation') or {}
            hour = _tokens(creation, 'ephemeral_1h_input_tokens')
            if hour > written:
                raise ValueError('Provider returned invalid cache usage; generation stopped.')
            cost = inputs * input_price + cached * read_price + (written - hour) * write5 + hour * write1 + outputs * output_price
        else:
            inputs = _tokens(usage, 'input_tokens' if 'input_tokens' in usage else 'prompt_tokens')
            outputs = _tokens(usage, 'output_tokens' if 'output_tokens' in usage else 'completion_tokens')
            details = usage.get('input_tokens_details') or usage.get('prompt_tokens_details') or {}
            cached = _tokens(details, 'cached_tokens')
            if cached > inputs:
                raise ValueError('Provider returned invalid cache usage; generation stopped.')
            if inputs > 272000:
                input_price *= 2
                read_price *= 2
                output_price *= Decimal('1.5')
            # Reasoning is already included in the reported output tokens.
            cost = (inputs - cached) * input_price + cached * read_price + outputs * output_price
        self.spent += cost / 1000000
        if self.spent > MAX_GENERATION_COST_USD:
            raise GenerationBudgetExceeded()
