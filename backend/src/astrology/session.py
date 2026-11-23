"""Stateless model decisions from the brief, current source and latest render."""

import base64
import json

import httpx

from ..utils.generation_budget import GenerationBudget, input_token_bound
from ..utils.llm_tool_conversation import OPENAI_URL, ToolCall, Turn
from .agent import FINAL_TOOLS, MODEL, SYSTEM, TOOLS


def picture(data, mime):
    encoded = base64.b64encode(data).decode("ascii")
    return {"type": "input_image", "detail": "high", "image_url": f"data:{mime};base64,{encoded}"}


def open_client(key):
    transport = httpx.AsyncHTTPTransport(
        http2=True, retries=2, limits=httpx.Limits(max_keepalive_connections=0)
    )
    return httpx.AsyncClient(
        headers={"Authorization": f"Bearer {key}"}, timeout=180, transport=transport
    )


class Session:
    def __init__(self, client, prompt, limit, reference):
        self.client = client
        self.brief = [{"type": "input_text", "text": f"Piece ceiling: {limit}.\nBrief: {prompt}"}]
        if reference:
            self.brief.append(picture(reference, "image/jpeg"))
        self.budget = GenerationBudget(MODEL)

    async def decide(self, program, feedback, view, *, final_review=False):
        context = json.dumps(
            {"current_sections_in_order": program, "recent_tool_results": feedback}
        )
        content = [*self.brief, {"type": "input_text", "text": context}]
        if view:
            content += [
                {"type": "input_text", "text": "Current LDraw model, front-left and rear-right:"},
                picture(view, "image/jpeg"),
            ]
        payload = {
            "model": MODEL,
            "store": False,
            "service_tier": "default",
            "reasoning": {"effort": "medium"},
            "input": [
                {"role": "developer", "content": SYSTEM},
                {"role": "user", "content": content},
            ],
            "tools": [
                {
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.schema,
                    "strict": True,
                }
                for t in (FINAL_TOOLS if final_review else TOOLS)
            ],
            "tool_choice": "required",
            "parallel_tool_calls": False,
        }
        payload["max_output_tokens"] = self.budget.output_limit(input_token_bound(payload), 6000)
        response = await self.client.post(OPENAI_URL, json=payload)
        response.raise_for_status()
        data = response.json()
        self.budget.record_usage(data.get("usage"), "openai")
        if data.get("status") != "completed":
            raise ValueError("The model decision was incomplete. The last design is checkpointed")
        calls = []
        for item in data["output"]:
            if item.get("type") == "function_call":
                args = json.loads(item["arguments"])
                if not isinstance(args, dict):
                    raise ValueError("Invalid Astrology tool arguments")
                calls.append(ToolCall(item["call_id"], item["name"], args))
        return Turn(tool_calls=calls)
