"""The agent loop: ask the model, run its tools, record everything, stop on time."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Callable

from .provider import Budget, BudgetExhausted, ModelClient, estimate_tokens
from .session import Session
from .tools import Toolbox

Event = Callable[[str, dict], None]
NUDGE = ("You stopped without publishing. Keep working: fix what the build report and the renders show, then "
         "call finish. If the model cannot be improved further, publish the best error-free build and say "
         "plainly what is missing.")
CUT_OFF = ("Your last tool call was cut off by the output limit, so it was not run. Send it again in a "
           "shorter form; for a local change use edit_script instead of rewriting the script.")
WRAP_UP = ("Harness note: {reason}. Bring the build to an error-free state, render that revision and call "
           "finish now; do not start new features.")


@dataclass(frozen=True)
class RunResult:
    status: str  # published | draft | failed | refused
    reason: str
    steps: int
    spent_usd: Decimal
    published: dict | None


def close_run(session: Session, toolbox: Toolbox, budget: Budget, emit: Event, status: str | None, reason: str,
              steps: int, published_before: int) -> RunResult:
    """Record how a run ended. A run that stops before ``finish`` keeps its best result as a draft."""
    published = session.meta["published"][-1] if len(session.meta["published"]) > published_before else None
    if status is None:
        status = "published" if published else "failed"
        if published is None and toolbox.publish_draft(reason):
            # Keep the customer's best result: the last error-free build, marked as unreviewed.
            published, status = session.meta["published"][-1], "draft"
    session.meta["status"] = status
    session.save()
    emit("done", {"status": status, "reason": reason})
    return RunResult(status, reason, steps, budget.spent, published)


class BuildAgent:
    def __init__(self, session: Session, client: ModelClient, toolbox: Toolbox, budget: Budget, *,
                 max_steps: int = 60, max_tokens: int = 32_000, on_event: Event | None = None):
        self._session = session
        self._client = client
        self._toolbox = toolbox
        self._budget = budget
        self._max_steps = max_steps
        self._max_tokens = max_tokens
        self._emit = on_event or (lambda kind, data: None)

    def run(self, content: list[dict]) -> RunResult:
        """Add a user turn (a new request or a follow-up edit) and work until it is done."""
        session = self._session
        published_before = len(session.meta["published"])
        session.meta["status"] = "running"
        session.append("user", content)
        nudged = warned = False
        steps = 0
        reason = "step limit reached"
        while steps < self._max_steps:
            try:
                allowance = self._budget.output_allowance(estimate_tokens(session.messages[-1]), self._max_tokens)
            except BudgetExhausted:
                reason = "AI budget used up"
                break
            reply = self._client.send(session.meta["system"], session.meta["tools"], session.api_messages(),
                                      max_tokens=allowance,
                                      on_delta=lambda kind, text: self._emit(kind, {"text": text}))
            steps += 1
            self._budget.record(reply)
            session.meta["usage"] = session.meta.get("usage", []) + self._budget.calls[-1:]
            self._emit("turn", {"step": steps, "spent_usd": str(self._budget.spent)})
            if reply.stop_reason == "refusal":
                # A declined turn is not part of the conversation; its content must not be replayed.
                session.save()
                return self._close("refused", "the model declined the request", steps, published_before)
            if not reply.content:
                reason = "the model returned an empty reply"
                break
            session.append("assistant", reply.content)
            calls = [block for block in reply.content if block.get("type") == "tool_use"]
            if not calls:
                if reply.stop_reason == "max_tokens":
                    session.append("user", [{"type": "text", "text": CUT_OFF}])
                    continue
                if reply.stop_reason == "pause_turn":
                    continue
                if len(session.meta["published"]) > published_before or nudged:
                    reason = "the model ended its turn"
                    break
                nudged = True
                session.append("user", [{"type": "text", "text": NUDGE}])
                continue

            results, finished = [], False
            for position, call in enumerate(calls):
                cut = reply.stop_reason == "max_tokens" and position == len(calls) - 1
                if call.get("id") in reply.invalid_inputs or cut:
                    text, images, is_error = CUT_OFF if cut else (
                        "Your tool input was not valid JSON, so the tool was not run. Send the call again."), [], True
                else:
                    self._emit("tool_call", {"name": call.get("name"), "input": call.get("input")})
                    output = self._toolbox.call(call.get("name"), call.get("input"))
                    text, images, is_error = output.text, output.images, output.is_error
                    finished = finished or output.finished
                    self._emit("tool_result", {"name": call.get("name"), "text": text, "is_error": is_error,
                                               "images": [str(path) for path in images]})
                block = {"type": "tool_result", "tool_use_id": call.get("id"),
                         "content": [{"type": "text", "text": text}, *(session.image_block(p) for p in images)]}
                if is_error:
                    block["is_error"] = True
                results.append(block)
            if finished:
                session.append("user", results)
                return self._close("published", "finished", steps, published_before)
            left = self._max_steps - steps
            low_budget = self._budget.remaining < self._budget.limit * Decimal("0.25")
            if not warned and (left <= 8 or low_budget):
                warned = True
                why = f"only {left} steps remain" if left <= 8 else "the AI budget is nearly used up"
                results.append({"type": "text", "text": WRAP_UP.format(reason=why)})
            session.append("user", results)
        return self._close(None, reason, steps, published_before)

    def _close(self, status: str | None, reason: str, steps: int, published_before: int) -> RunResult:
        return close_run(self._session, self._toolbox, self._budget, self._emit, status, reason, steps,
                         published_before)
