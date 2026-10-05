"""Provider-neutral, multi-turn tool-use conversations with Anthropic and OpenAI models.

Callers describe tools once (ToolSpec), read each model turn as ToolCalls plus text, and answer
with ToolResults (text and an optional PNG). Each provider adapter translates that into its own
wire format, so the design loop in llmToBricks doesn't depend on either API.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence

import httpx
from fastapi import HTTPException

from .generation_budget import GenerationBudget, input_token_bound

logger = logging.getLogger(__name__)

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_API_VERSION = os.getenv("ANTHROPIC_API_VERSION", "2023-06-01")
OPENAI_URL = "https://api.openai.com/v1/responses"


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    schema: Dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    input: Dict[str, Any]


@dataclass(frozen=True)
class ToolResult:
    call_id: str
    text: str
    image_png: Optional[bytes] = None
    is_error: bool = False


@dataclass(frozen=True)
class Turn:
    tool_calls: List[ToolCall] = field(default_factory=list)
    text: str = ""
    truncated: bool = False


@dataclass(frozen=True)
class UserInput:
    text: str
    image_base64: Optional[str] = None
    image_media_type: str = "image/png"


@dataclass(frozen=True)
class ConversationSettings:
    model: str
    system: str
    tools: Sequence[ToolSpec]
    max_tokens: int
    enforce_cost_limit: bool = False
    reasoning_effort: str = "medium"  # OpenAI only; Anthropic uses adaptive thinking


async def post_json(client: httpx.AsyncClient, url: str, headers: Dict[str, str],
                    payload: Dict[str, Any], provider: str) -> Dict[str, Any]:
    try:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        return response.json()
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail=f"{provider} request timed out") from exc
    except httpx.HTTPStatusError as exc:
        logger.error("%s request failed with HTTP %s", provider, exc.response.status_code)
        raise HTTPException(
            status_code=502, detail=f"{provider} request failed: HTTP {exc.response.status_code}"
        ) from exc
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail=f"{provider} request failed") from exc


async def post_stream_json(client, url, headers, payload, provider, on_text):
    """Reassemble tools while forwarding text and Claude's exposed thinking deltas."""
    content = []
    tool_json = {}
    result = {}
    completed = False
    try:
        async with client.stream("POST", url, headers=headers, json={**payload, "stream": True}) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                event = json.loads(raw)
                kind = event.get("type")
                if kind in {"error", "response.failed"}:
                    raise HTTPException(status_code=502, detail=f"{provider} stream failed")
                if provider == "OpenAI":
                    if kind in {"response.output_text.delta", "response.reasoning_summary_text.delta"}:
                        await on_text(event.get("delta", ""))
                    elif kind == "response.output_item.added" and event.get("item", {}).get("type") == "function_call":
                        await on_text(f"\n\nDesign output ({event['item'].get('name', 'design')}):\n")
                    elif kind == "response.function_call_arguments.delta":
                        await on_text(event.get("delta", ""))
                    elif kind == "response.function_call_arguments.done":
                        await on_text("\n\n")
                    elif kind == "response.reasoning_summary_text.done":
                        await on_text("\n\n")
                    elif kind in {"response.completed", "response.incomplete"}:
                        result = event.get("response", {})
                        completed = True
                elif kind == "content_block_start":
                    index = event["index"]
                    while len(content) <= index:
                        content.append({})
                    content[index] = dict(event["content_block"])
                    if content[index].get("type") == "tool_use":
                        tool_json[index] = ""
                        await on_text(f"\n\nDesign output ({content[index].get('name', 'design')}):\n")
                elif kind == "content_block_delta":
                    index = event["index"]
                    delta = event["delta"]
                    delta_type = delta.get("type")
                    if delta_type == "input_json_delta":
                        tool_json[index] = tool_json.get(index, "") + delta.get("partial_json", "")
                        await on_text(delta.get("partial_json", ""))
                    else:
                        field = {"text_delta": "text", "thinking_delta": "thinking", "signature_delta": "signature"}.get(delta_type)
                        if field:
                            content[index][field] = content[index].get(field, "") + delta.get(field, "")
                            if field in {"text", "thinking"}:
                                await on_text(delta.get(field, ""))
                elif kind == "content_block_stop" and event["index"] not in tool_json:
                    await on_text("\n\n")
                elif kind == "content_block_stop" and event["index"] in tool_json:
                    index = event["index"]
                    content[index]["input"] = json.loads(tool_json[index] or "{}")
                    await on_text("\n\n")
                elif kind == "message_start":
                    result["usage"] = dict(event.get("message", {}).get("usage", {}))
                elif kind == "message_delta":
                    result.update(event.get("delta", {}))
                    result.setdefault("usage", {}).update(event.get("usage", {}))
                elif kind == "message_stop":
                    result["content"] = content
                    completed = True
        if not completed:
            raise HTTPException(status_code=502, detail=f"{provider} stream ended before completion")
        await on_text("\n\n")
        return result
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail=f"{provider} request timed out") from exc
    except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
        raise HTTPException(status_code=502, detail=f"{provider} stream failed") from exc


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise HTTPException(status_code=503, detail=f"{name} is not configured")
    return value


class ToolConversation(ABC):
    """One multi-turn conversation. Queue input with add_*, then call send() for the next turn."""

    def __init__(self, client: httpx.AsyncClient, settings: ConversationSettings):
        self.client = client
        self.settings = settings
        self.budget = GenerationBudget(settings.model) if settings.enforce_cost_limit else None
        self.context_tokens = 0
        self.on_text: Optional[Callable[[str], Awaitable[None]]] = None

    def budget_payload(self, payload, output_key):
        if self.budget:
            bound = input_token_bound(payload) + self.context_tokens
            payload[output_key] = self.budget.output_limit(bound, payload[output_key])
        return payload

    def account_response(self, response, provider):
        if self.budget:
            usage = response.get('usage')
            self.budget.record_usage(usage, provider)
            if provider == 'openai':
                self.context_tokens = usage['input_tokens'] + usage['output_tokens']

    async def send_stream(self, on_text: Callable[[str], Awaitable[None]]) -> Turn:
        self.on_text = on_text
        try:
            return await self.send()
        finally:
            self.on_text = None

    @abstractmethod
    async def send(self) -> Turn: ...

    @abstractmethod
    def add_tool_results(self, results: Sequence[ToolResult]) -> None: ...

    @abstractmethod
    def add_user_text(self, text: str) -> None: ...


class AnthropicToolConversation(ToolConversation):
    def __init__(self, client: httpx.AsyncClient, settings: ConversationSettings, user_input: UserInput):
        super().__init__(client, settings)
        self._headers = self._build_headers()
        content: List[Dict[str, Any]] = []
        if user_input.image_base64:
            content.append({"type": "image", "source": {
                "type": "base64", "media_type": user_input.image_media_type, "data": user_input.image_base64}})
        content.append({"type": "text", "text": user_input.text})
        self.messages: List[Dict[str, Any]] = [{"role": "user", "content": content}]

    @staticmethod
    def _build_headers() -> Dict[str, str]:
        headers = {
            "x-api-key": _require_env("ANTHROPIC_API_KEY"),
            "anthropic-version": ANTHROPIC_API_VERSION,
            "content-type": "application/json",
        }
        workspace_id = os.getenv("ANTHROPIC_WORKSPACE_ID")
        if workspace_id:
            headers["anthropic-workspace-id"] = workspace_id
        return headers

    def payload(self) -> Dict[str, Any]:
        return {
            "model": self.settings.model,
            "max_tokens": self.settings.max_tokens,
            "system": self.settings.system,
            "thinking": {"type": "adaptive", "display": "summarized"},
            "messages": self.messages,
            # Shape arrays can take most of a turn to write. Stream fragments
            # immediately rather than buffering each complete tool parameter.
            "tools": [{"name": t.name, "description": t.description, "input_schema": t.schema,
                       **({"eager_input_streaming": True} if self.on_text else {})}
                      for t in self.settings.tools],
            # Opus 5.5 rejects forced tool use; the system prompt asks for the tool.
            "tool_choice": {"type": "auto"},
        }

    async def send(self) -> Turn:
        response = (await post_stream_json(self.client, ANTHROPIC_URL, self._headers, self.budget_payload(self.payload(), "max_tokens"), "Anthropic", self.on_text)
                    if self.on_text else await post_json(self.client, ANTHROPIC_URL, self._headers, self.budget_payload(self.payload(), "max_tokens"), "Anthropic"))
        self.account_response(response, "anthropic")
        content = response.get("content", [])
        self.messages.append({"role": "assistant", "content": content})
        calls = [ToolCall(id=b.get("id", ""), name=b.get("name", ""),
                          input=b.get("input") if isinstance(b.get("input"), dict) else {})
                 for b in content if b.get("type") == "tool_use"]
        text = "\n".join(b["text"] for b in content
                         if b.get("type") == "text" and isinstance(b.get("text"), str)).strip()
        return Turn(tool_calls=calls, text=text, truncated=response.get("stop_reason") == "max_tokens")

    def add_tool_results(self, results: Sequence[ToolResult]) -> None:
        blocks = []
        for result in results:
            content: Any = result.text
            if result.image_png is not None:
                content = [{"type": "text", "text": result.text},
                           {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                        "data": base64.b64encode(result.image_png).decode()}}]
            block: Dict[str, Any] = {"type": "tool_result", "tool_use_id": result.call_id, "content": content}
            if result.is_error:
                block["is_error"] = True
            blocks.append(block)
        self.messages.append({"role": "user", "content": blocks})

    def add_user_text(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})


class OpenAIToolConversation(ToolConversation):
    """Uses the Responses API, chaining turns with previous_response_id so reasoning carries over."""

    def __init__(self, client: httpx.AsyncClient, settings: ConversationSettings, user_input: UserInput):
        super().__init__(client, settings)
        self._headers = {
            "Authorization": f"Bearer {_require_env('OPENAI_API_KEY')}",
            "Content-Type": "application/json",
        }
        content: List[Dict[str, Any]] = []
        if user_input.image_base64:
            content.append({"type": "input_image", "detail": "high",
                            "image_url": f"data:{user_input.image_media_type};base64,{user_input.image_base64}"})
        content.append({"type": "input_text", "text": user_input.text})
        self.pending: List[Dict[str, Any]] = [{"role": "user", "content": content}]
        self.previous_response_id: Optional[str] = None

    def payload(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": self.settings.model,
            "instructions": self.settings.system,
            "input": self.pending,
            "tools": [{"type": "function", "name": t.name, "description": t.description,
                       "parameters": t.schema} for t in self.settings.tools],
            "tool_choice": "auto",
            "reasoning": {"effort": self.settings.reasoning_effort, "summary": "auto"},
            "max_output_tokens": self.settings.max_tokens,
        }
        if self.previous_response_id:
            payload["previous_response_id"] = self.previous_response_id
        return payload

    async def send(self) -> Turn:
        response = (await post_stream_json(self.client, OPENAI_URL, self._headers, self.budget_payload(self.payload(), "max_output_tokens"), "OpenAI", self.on_text)
                    if self.on_text else await post_json(self.client, OPENAI_URL, self._headers, self.budget_payload(self.payload(), "max_output_tokens"), "OpenAI"))
        self.account_response(response, "openai")
        self.pending = []
        self.previous_response_id = response.get("id")
        calls: List[ToolCall] = []
        texts: List[str] = []
        for item in response.get("output", []):
            if item.get("type") == "function_call":
                try:
                    arguments = json.loads(item.get("arguments") or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                calls.append(ToolCall(id=item.get("call_id", ""), name=item.get("name", ""),
                                      input=arguments if isinstance(arguments, dict) else {}))
            elif item.get("type") == "message":
                texts += [c["text"] for c in item.get("content", [])
                          if c.get("type") == "output_text" and isinstance(c.get("text"), str)]
        truncated = (response.get("status") == "incomplete"
                     and (response.get("incomplete_details") or {}).get("reason") == "max_output_tokens")
        return Turn(tool_calls=calls, text="\n".join(texts).strip(), truncated=truncated)

    def add_tool_results(self, results: Sequence[ToolResult]) -> None:
        for result in results:
            text = f"Error: {result.text}" if result.is_error else result.text
            output: Any = text
            if result.image_png is not None:
                output = [{"type": "input_text", "text": text},
                          {"type": "input_image", "detail": "high",
                           "image_url": "data:image/png;base64," + base64.b64encode(result.image_png).decode()}]
            self.pending.append({"type": "function_call_output", "call_id": result.call_id, "output": output})

    def add_user_text(self, text: str) -> None:
        self.pending.append({"role": "user", "content": [{"type": "input_text", "text": text}]})


PROVIDERS = {"anthropic": AnthropicToolConversation, "openai": OpenAIToolConversation}


def create_conversation(provider: str, client: httpx.AsyncClient, settings: ConversationSettings,
                        user_input: UserInput) -> ToolConversation:
    try:
        conversation_cls = PROVIDERS[provider]
    except KeyError as exc:
        raise ValueError(f"Unsupported LLM provider: {provider}") from exc
    return conversation_cls(client, settings, user_input)
