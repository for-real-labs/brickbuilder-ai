"""OpenAI models behind the same agent loop, through the Responses API.

The session transcript has one shape whichever provider is used. This adapter
translates it on the way out and, on the way back, keeps every output item verbatim
on the block it became, so a replayed turn is exactly what the model produced.

Requests are stateless (``store: false``): the conversation and the customer's
picture live in the session directory, not in a stored OpenAI response. Reasoning is
carried between turns by passing each reasoning item back as it arrived.
"""

from __future__ import annotations

import json
import time
from typing import Callable

import httpx

from .provider import ModelReply, ProviderError, with_retries

API_URL = "https://api.openai.com/v1/responses"
ITEM = "openai_item"  # the provider's own output item, stored on the transcript block made from it
_RETRYABLE_FAILURES = {"server_error": 500, "rate_limit_exceeded": 429}


def is_openai_model(model: str) -> bool:
    return model.startswith("gpt-")


def to_function_tools(tools: list[dict]) -> list[dict]:
    """Tool definitions as Responses API functions.

    ``strict`` is off because several tools have optional arguments; strict mode would make the
    model send every one. The toolbox validates arguments itself.
    """
    return [{"type": "function", "name": tool["name"], "description": tool.get("description", ""),
             "parameters": tool.get("input_schema") or {"type": "object", "properties": {}}, "strict": False}
            for tool in tools]


def _part(block: dict) -> dict:
    kind = block.get("type")
    if kind == "text":
        return {"type": "input_text", "text": block.get("text", "")}
    if kind == "image" and block.get("source", {}).get("type") == "base64":
        source = block["source"]
        return {"type": "input_image", "detail": "high",
                "image_url": f"data:{source['media_type']};base64,{source['data']}"}
    raise ProviderError(f"A {kind} block cannot be sent to an OpenAI model")


def _tool_output(block: dict) -> dict:
    content = block.get("content")
    parts = ([_part(part) for part in content] if isinstance(content, list)
             else [{"type": "input_text", "text": str(content or "")}])
    if block.get("is_error"):
        if parts and parts[0]["type"] == "input_text":
            parts[0] = {"type": "input_text", "text": f"Error: {parts[0]['text']}"}
        else:
            parts.insert(0, {"type": "input_text", "text": "Error"})
    plain = len(parts) == 1 and parts[0]["type"] == "input_text"
    return {"type": "function_call_output", "call_id": block.get("tool_use_id"),
            "output": parts[0]["text"] if plain else parts}


def _is_json_object(text) -> bool:
    try:
        return isinstance(text, str) and isinstance(json.loads(text), dict)
    except ValueError:
        return False


def _replayed(block: dict) -> dict | None:
    """An earlier assistant block as input: the original item when it is whole, a rebuilt one if not."""
    item = block.get(ITEM)
    whole = isinstance(item, dict) and item.get("status") in (None, "completed")
    kind = block.get("type")
    if kind == "tool_use":
        if whole and _is_json_object(item.get("arguments")):
            return item
        # A call that was cut off or was not valid JSON never ran; replay it in a form the API accepts.
        return {"type": "function_call", "call_id": block.get("id"), "name": block.get("name"),
                "arguments": json.dumps(block.get("input") or {})}
    if kind == "reasoning":
        # Without its encrypted content a reasoning item cannot be resolved by a stateless request.
        return item if whole and item.get("encrypted_content") else None
    if kind == "text":
        return item if whole else {"role": "assistant", "content": [
            {"type": "output_text", "text": block.get("text", "")}]}
    if whole:
        return item
    raise ProviderError("This session was started with another AI provider and cannot continue on an OpenAI model")


def to_input_items(messages: list[dict]) -> list[dict]:
    """The transcript as Responses API input, in order."""
    items: list[dict] = []
    for message in messages:
        content = message.get("content")
        blocks = [{"type": "text", "text": content}] if isinstance(content, str) else list(content or [])
        if message.get("role") == "assistant":
            items += [item for item in map(_replayed, blocks) if item is not None]
            continue
        said: list[dict] = []
        for block in blocks:
            if block.get("type") == "tool_result":
                if said:
                    items.append({"role": "user", "content": said})
                    said = []
                items.append(_tool_output(block))
            else:
                said.append(_part(block))
        if said:
            items.append({"role": "user", "content": said})
    return items


def _count(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ProviderError("OpenAI reported invalid token usage")
    return value


def _usage(reported) -> dict:
    """OpenAI's ``input_tokens`` includes cached and cache-written tokens; split them out."""
    if not isinstance(reported, dict) or "input_tokens" not in reported or "output_tokens" not in reported:
        raise ProviderError("OpenAI did not report token usage")
    details = reported.get("input_tokens_details") or {}
    total = _count(reported["input_tokens"])
    read, written = _count(details.get("cached_tokens") or 0), _count(details.get("cache_write_tokens") or 0)
    if read + written > total:
        raise ProviderError("OpenAI reported invalid cache usage")
    return {"input_tokens": total - read - written, "output_tokens": _count(reported["output_tokens"]),
            "cache_read_input_tokens": read, "cache_creation_input_tokens": written}


def from_response(response: dict, requested_model: str) -> ModelReply:
    """A finished or cut-off Response as one transcript turn."""
    content: list[dict] = []
    invalid: dict[str, str] = {}
    refused = False
    for item in response.get("output") or []:
        kind = item.get("type")
        if kind == "reasoning":
            summary = "\n\n".join(part.get("text", "") for part in item.get("summary") or [])
            content.append({"type": "reasoning", "summary": summary, ITEM: item})
        elif kind == "message":
            parts = item.get("content") or []
            refused = refused or any(part.get("type") == "refusal" for part in parts)
            text = "".join(part.get("text", "") for part in parts if part.get("type") == "output_text")
            content.append({"type": "text", "text": text, ITEM: item})
        elif kind == "function_call":
            call_id, raw = item.get("call_id") or "", item.get("arguments") or ""
            try:
                parsed = json.loads(raw) if raw.strip() else {}
                if not isinstance(parsed, dict):
                    raise ValueError("tool input must be an object")
            except ValueError:
                parsed, invalid[call_id] = {}, raw
            # Some models send null for an argument they mean to leave out.
            arguments = {key: value for key, value in parsed.items() if value is not None}
            content.append({"type": "tool_use", "id": call_id, "name": item.get("name", ""),
                            "input": arguments, ITEM: item})
        else:
            content.append({"type": "provider_item", ITEM: item})
    incomplete = response.get("status") == "incomplete"
    why = (response.get("incomplete_details") or {}).get("reason")
    if refused or (incomplete and why == "content_filter"):
        stop_reason = "refusal"
    elif incomplete:
        stop_reason = "max_tokens"
    else:
        stop_reason = "tool_use" if any(block["type"] == "tool_use" for block in content) else "end_turn"
    return ModelReply(content=content, stop_reason=stop_reason, usage=_usage(response.get("usage")),
                      model=requested_model, stop_details={"reason": why} if why else None,
                      invalid_inputs=invalid)


class OpenAIClient:
    def __init__(self, api_key: str, *, model: str, effort: str = "high",
                 http: httpx.Client | None = None, max_retries: int = 4,
                 sleep: Callable[[float], None] = time.sleep, url: str = API_URL):
        if not api_key:
            raise ProviderError("OPENAI_API_KEY is not configured")
        if effort not in {"low", "medium", "high", "xhigh", "max"}:
            raise ProviderError("effort must be low, medium, high, xhigh or max")
        self.model = model
        self._effort = effort
        self._key = api_key
        self._http = http or httpx.Client(timeout=httpx.Timeout(600, connect=20))
        self._max_retries = max_retries
        self._sleep = sleep
        self._url = url

    def _body(self, system: str, tools: list[dict], messages: list[dict], max_tokens: int) -> dict:
        # The system prompt leads ``input`` as a developer message instead of going in ``instructions``:
        # GPT-6.2 models cached the conversation but not top-level instructions (observed 2026-11-22),
        # and every step sends the prompt again.
        prompt = {"role": "developer", "content": [{"type": "input_text", "text": system}]}
        return {
            "model": self.model, "input": [prompt, *to_input_items(messages)],
            "tools": to_function_tools(tools), "tool_choice": "auto",
            "reasoning": {"effort": self._effort, "summary": "auto"},
            "max_output_tokens": max_tokens, "stream": True,
            "store": False, "include": ["reasoning.encrypted_content"],
        }

    def send(self, system: str, tools: list[dict], messages: list[dict], *, max_tokens: int,
             on_delta: Callable[[str, str], None] | None = None) -> ModelReply:
        body = self._body(system, tools, messages, max_tokens)
        return with_retries(lambda: self._stream(body, on_delta), max_retries=self._max_retries, sleep=self._sleep)

    def _stream(self, body: dict, on_delta) -> ModelReply:
        headers = {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}
        notify = on_delta or (lambda kind, text: None)
        final: dict | None = None
        finished_items: list[dict] = []
        try:
            with self._http.stream("POST", self._url, headers=headers, json=body) as response:
                if response.status_code != 200:
                    response.read()
                    try:
                        detail = response.json().get("error") or {}
                        message = f"{detail.get('type', 'error')}: {detail.get('message', '')}"
                    except (ValueError, AttributeError):
                        message = "unexpected response"
                    if response.status_code == 401:
                        # OpenAI's own message quotes part of the rejected key.
                        message = "the API key was rejected"
                    raise ProviderError(f"OpenAI API {response.status_code} {message}"[:400], response.status_code)
                for line in response.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    event = json.loads(raw)
                    kind = event.get("type")
                    if kind == "response.output_text.delta":
                        notify("text", event.get("delta", ""))
                    elif kind == "response.reasoning_summary_text.delta":
                        notify("thinking", event.get("delta", ""))
                    elif kind == "response.reasoning_summary_text.done":
                        notify("thinking", "\n\n")
                    elif kind == "response.output_item.added" and event.get("item", {}).get("type") == "function_call":
                        notify("tool", event["item"].get("name", ""))
                    elif kind == "response.output_item.done":
                        finished_items.append(event.get("item") or {})
                    elif kind in ("response.completed", "response.incomplete"):
                        final = event.get("response")
                    elif kind == "response.failed":
                        code = ((event.get("response") or {}).get("error") or {}).get("code") or "failed"
                        raise ProviderError(f"OpenAI API response failed: {code}"[:200],
                                            _RETRYABLE_FAILURES.get(code, 400))
                    elif kind == "error":
                        code = event.get("code") or (event.get("error") or {}).get("code") or "error"
                        raise ProviderError(f"OpenAI API stream error: {code}"[:200],
                                            _RETRYABLE_FAILURES.get(code, 500))
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            raise ProviderError(f"OpenAI API request failed: {type(exc).__name__}") from None
        if not isinstance(final, dict):
            raise ProviderError("OpenAI API stream ended early")
        if not final.get("output") and finished_items:
            final = {**final, "output": finished_items}
        return from_response(final, self.model)
