"""Building agents that run inside the API process for All parts generations.

Nova runs in its own service. Astrology and the Fable variants run here. They are
chosen in Generation settings and offered only to the accounts on the allowlist.
"""

from __future__ import annotations

from dataclasses import dataclass

ASTROLOGY = "astrology"


@dataclass(frozen=True)
class FableVariant:
    """One way to run the Fable agent: a model, a method and the key that pays for it."""

    model: str
    method: str  # "thorough", "thorough-v2", "lean" or "lean-v2"; see docs/fable-agent.md
    key_env: str
    effort: str | None = None  # reasoning effort; None uses the method's own default


# The id is stored as the generation's model_used_3d, so never rename one: add a new id instead.
FABLE_AGENTS = {
    "fable-claude-fable-5-2": FableVariant("claude-fable-5-2", "thorough", "ANTHROPIC_API_KEY"),
    "fable-gpt-6.2-sol": FableVariant("gpt-6.2-sol", "thorough", "OPENAI_API_KEY"),
    # The v2 options add ready-made trees and automatic repair, and leave the first versions as they
    # were. Thorough v2 also has part measurements in its prompt and batched edits, to take fewer turns.
    "fable-thorough-v2-gpt-6.2-sol": FableVariant("gpt-6.2-sol", "thorough-v2", "OPENAI_API_KEY"),
    "fable-gpt-6.1-sol": FableVariant("gpt-6.1-sol", "thorough", "OPENAI_API_KEY"),
    "fable-lean-claude-fable-5-2": FableVariant("claude-fable-5-2", "lean", "ANTHROPIC_API_KEY"),
    # The cheapest Claude option. In its test run it built a plainer model than medium effort did.
    "fable-lean-low-claude-fable-5-2": FableVariant("claude-fable-5-2", "lean", "ANTHROPIC_API_KEY", effort="low"),
    "fable-lean-gpt-6.2-sol": FableVariant("gpt-6.2-sol", "lean", "OPENAI_API_KEY"),
    "fable-lean-v2-gpt-6.2-sol": FableVariant("gpt-6.2-sol", "lean-v2", "OPENAI_API_KEY"),
    "fable-lean-gpt-6.1-sol": FableVariant("gpt-6.1-sol", "lean", "OPENAI_API_KEY"),
}
IN_PROCESS_AGENTS = (ASTROLOGY, *FABLE_AGENTS)


def in_process_agent(value) -> str | None:
    """The agent's id when a generation was built here rather than by Nova."""
    return value if isinstance(value, str) and value in IN_PROCESS_AGENTS else None
