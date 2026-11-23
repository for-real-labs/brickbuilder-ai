"""The model behind the agent: streaming Messages API calls and their cost.

The backend talks to providers over plain HTTP, so this client does too. It never
edits earlier turns: Claude's thinking blocks are bound to the exact system prompt,
tool list and history that produced them.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from decimal import ROUND_FLOOR, Decimal
from typing import Callable, Protocol

import httpx

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
DEFAULT_MODEL = "claude-fable-5-2"
RETRY_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504, 529})
# USD per million tokens: input, output, cache read, 5-minute cache write.
# https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-22)
PRICES = {
    "claude-fable-5-2": ("8", "40", "0.20", "10"),
    "claude-opus-5-5": ("4", "20", "0.20", "5"),
    "claude-sonnet-5-5": ("2", "10", "0.10", "2.5"),
    "claude-opus-5": ("5", "25", "0.50", "6.25"),
    "claude-opus-4-8": ("5", "25", "0.50", "6.25"),
}
_FALLBACK_CAPABLE = ("claude-fable-5", "claude-opus-5", "claude-sonnet-5-5")


class ProviderError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class BudgetExhausted(RuntimeError):
    """The next model call could exceed the run's spending limit."""


@dataclass
class ModelReply:
    content: list[dict]
    stop_reason: str | None
    usage: dict
    model: str
    stop_details: dict | None = None
    invalid_inputs: dict[str, str] = field(default_factory=dict)  # tool_use id -> unparseable JSON


class ModelClient(Protocol):
    model: str

    def send(self, system: str, tools: list[dict], messages: list[dict], *, max_tokens: int,
             on_delta: Callable[[str, str], None] | None = None) -> ModelReply: ...


def _tokens(usage: dict, key: str) -> int:
    value = usage.get(key) or 0
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ProviderError("The provider reported invalid token usage")
    return value


def price_usage(model: str, usage: dict) -> Decimal:
    """Cost in USD. Unknown models fail closed rather than run without a budget."""
    if model not in PRICES:
        raise ProviderError(f"No pricing is configured for model {model}")
    if "input_tokens" not in usage or "output_tokens" not in usage:
        raise ProviderError("The provider did not report token usage")
    rate_in, rate_out, rate_read, rate_write = (Decimal(p) for p in PRICES[model])
    cost = (_tokens(usage, "input_tokens") * rate_in + _tokens(usage, "output_tokens") * rate_out
            + _tokens(usage, "cache_read_input_tokens") * rate_read
            + _tokens(usage, "cache_creation_input_tokens") * rate_write)
    return cost / Decimal(1_000_000)


class Budget:
    """A hard spending limit for one run, enforced before each call."""

    def __init__(self, limit_usd: Decimal | float | str, model: str):
        if model not in PRICES:
            raise ProviderError(f"No pricing is configured for model {model}")
        self.limit = Decimal(str(limit_usd))
        self.model = model
        self.spent = Decimal(0)
        self.calls: list[dict] = []
        self._context_tokens = 0

    @property
    def remaining(self) -> Decimal:
        return self.limit - self.spent

    def output_allowance(self, new_input_tokens: int, requested: int) -> int:
        """Output tokens the next call may use, reserving its whole input at the highest rate."""
        rate_in, rate_out, _, rate_write = (Decimal(p) for p in PRICES[self.model])
        reserve = Decimal(self._context_tokens + new_input_tokens) * max(rate_in, rate_write) / Decimal(1_000_000)
        allowance = int(((self.remaining - reserve) * Decimal(1_000_000) / rate_out)
                        .to_integral_value(rounding=ROUND_FLOOR))
        if allowance < 2048:
            raise BudgetExhausted("The run's AI budget is used up")
        return min(requested, allowance)

    def record(self, reply: ModelReply) -> Decimal:
        served_by = reply.model if reply.model in PRICES else self.model
        cost = price_usage(served_by, reply.usage)
        self.spent += cost
        usage = reply.usage
        self._context_tokens = (_tokens(usage, "input_tokens") + _tokens(usage, "cache_read_input_tokens")
                                + _tokens(usage, "cache_creation_input_tokens") + _tokens(usage, "output_tokens"))
        self.calls.append({
            "model": served_by, "input_tokens": _tokens(usage, "input_tokens"),
            "output_tokens": _tokens(usage, "output_tokens"),
            "cache_read_tokens": _tokens(usage, "cache_read_input_tokens"),
            "cache_write_tokens": _tokens(usage, "cache_creation_input_tokens"),
            "estimated_cost_usd": str(cost),
        })
        return cost


def estimate_tokens(content) -> int:
    """A deliberately high bound for content about to be sent for the first time."""
    if isinstance(content, dict):
        if content.get("type") == "image":
            return 6000
        return sum(estimate_tokens(value) for value in content.values()) + 8
    if isinstance(content, list):
        return sum(estimate_tokens(item) for item in content) + 8
    if isinstance(content, str):
        return len(content.encode("utf-8")) // 2 + 8
    return 8


class AnthropicClient:
    def __init__(self, api_key: str, *, model: str = DEFAULT_MODEL, effort: str = "high",
                 http: httpx.Client | None = None, fallbacks: bool = True, max_retries: int = 4,
                 sleep: Callable[[float], None] = time.sleep, url: str = API_URL):
        if not api_key:
            raise ProviderError("ANTHROPIC_API_KEY is not configured")
        if effort not in {"low", "medium", "high", "xhigh", "max"}:
            raise ProviderError("effort must be low, medium, high, xhigh or max")
        self.model = model
        self._effort = effort
        self._key = api_key
        self._http = http or httpx.Client(timeout=httpx.Timeout(600, connect=20))
        # A declined request is retried on the model Anthropic recommends for that case.
        self._fallbacks = fallbacks and model.startswith(_FALLBACK_CAPABLE)
        self._auto_cache = True
        self._max_retries = max_retries
        self._sleep = sleep
        self._url = url

    def _request(self, system: str, tools: list[dict], messages: list[dict], max_tokens: int) -> tuple[dict, dict]:
        headers = {"x-api-key": self._key, "anthropic-version": API_VERSION, "content-type": "application/json"}
        body = {
            "model": self.model, "max_tokens": max_tokens, "stream": True,
            # The frozen prefix gets its own cache point; the growing transcript is cached automatically.
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "tools": [{**tool, "eager_input_streaming": True} for tool in tools],
            "messages": messages,
            "thinking": {"type": "adaptive", "display": "summarized"},
            "output_config": {"effort": self._effort},
        }
        if self._auto_cache:
            body["cache_control"] = {"type": "ephemeral"}
        if self._fallbacks:
            headers["anthropic-beta"] = FALLBACK_BETA
            body["fallbacks"] = "default"
        return headers, body

    def send(self, system: str, tools: list[dict], messages: list[dict], *, max_tokens: int,
             on_delta: Callable[[str, str], None] | None = None) -> ModelReply:
        attempt = 0
        while True:
            headers, body = self._request(system, tools, messages, max_tokens)
            try:
                return self._stream(headers, body, on_delta)
            except ProviderError as exc:
                # Two request features are optional conveniences. If this account or route does not
                # offer one, drop it once and carry on rather than failing the build.
                if exc.status == 400 and self._fallbacks and "fallback" in str(exc).lower():
                    self._fallbacks = False
                    continue
                if exc.status == 400 and self._auto_cache and "cache_control" in str(exc).lower():
                    self._auto_cache = False
                    continue
                attempt += 1
                if (exc.status is not None and exc.status not in RETRY_STATUS) or attempt > self._max_retries:
                    raise
                self._sleep(min(60.0, 3.0 * 2 ** (attempt - 1)))

    def _stream(self, headers: dict, body: dict, on_delta) -> ModelReply:
        content: list[dict] = []
        partial: dict[int, str] = {}
        usage: dict = {}
        result: dict = {"model": self.model}
        invalid: dict[str, str] = {}
        finished = False
        try:
            with self._http.stream("POST", self._url, headers=headers, json=body) as response:
                if response.status_code != 200:
                    response.read()
                    try:
                        detail = response.json().get("error", {})
                        message = f"{detail.get('type', 'error')}: {detail.get('message', '')}"
                    except ValueError:
                        message = "unexpected response"
                    raise ProviderError(f"Claude API {response.status_code} {message}"[:400], response.status_code)
                for line in response.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    event = json.loads(line[5:])
                    kind = event.get("type")
                    if kind == "message_start":
                        message = event.get("message", {})
                        usage.update(message.get("usage") or {})
                        result["model"] = message.get("model") or self.model
                    elif kind == "content_block_start":
                        index = event["index"]
                        while len(content) <= index:
                            content.append({})
                        content[index] = dict(event["content_block"])
                        if content[index].get("type") == "tool_use":
                            partial[index] = ""
                            if on_delta:
                                on_delta("tool", content[index].get("name", ""))
                    elif kind == "content_block_delta":
                        index, delta = event["index"], event["delta"]
                        variety = delta.get("type")
                        if variety == "input_json_delta":
                            partial[index] = partial.get(index, "") + delta.get("partial_json", "")
                        elif variety in ("text_delta", "thinking_delta", "signature_delta"):
                            name = variety[:-6]
                            content[index][name] = content[index].get(name, "") + delta.get(name, "")
                            if on_delta and name != "signature":
                                on_delta(name, delta.get(name, ""))
                    elif kind == "message_delta":
                        result.update(event.get("delta") or {})
                        usage.update(event.get("usage") or {})
                    elif kind == "message_stop":
                        finished = True
                    elif kind == "error":
                        detail = event.get("error", {})
                        status = 529 if detail.get("type") == "overloaded_error" else 500
                        raise ProviderError(f"Claude API stream error: {detail.get('type', 'error')}", status)
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError(f"Claude API request failed: {type(exc).__name__}") from None
        if not finished:
            raise ProviderError("Claude API stream ended early")
        for index, raw in partial.items():
            block = content[index]
            try:
                # Eager streaming skips server-side validation, so parse strictly here.
                parsed = json.loads(raw) if raw.strip() else {}
                if not isinstance(parsed, dict):
                    raise ValueError("tool input must be an object")
                block["input"] = parsed
            except ValueError:
                block["input"] = {}
                invalid[block.get("id", "")] = raw
        return ModelReply(content=content, stop_reason=result.get("stop_reason"), usage=usage,
                          model=result.get("model") or self.model, stop_details=result.get("stop_details"),
                          invalid_inputs=invalid)
