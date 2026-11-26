"""Building agents that run inside the API process for All parts generations.

Nova runs in its own service. Astrology and the Fable variants run here. They are
chosen in Generation settings and offered only to the accounts on the allowlist.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

ASTROLOGY = "astrology"
PIP_AGENT = "pip-agent"


@dataclass(frozen=True)
class FableVariant:
    """One way to run the Fable agent: a model, a method and the key that pays for it."""

    model: str
    method: str  # "thorough", "thorough-v2", "lean" or "lean-v2"; see docs/fable-agent.md
    key_env: str
    effort: str | None = None  # reasoning effort; None uses the method's own default
    models: tuple[str, ...] = ()  # models the customer may pick instead of ``model``; empty means none

    def using(self, model: str | None) -> FableVariant:
        """This option on ``model``, which must be one it offers. None keeps its default model."""
        if model is None or model == self.model:
            return self
        if model not in self.models:
            raise ValueError("This building agent does not offer that model")
        return replace(self, model=model, key_env=key_env_for(model))


def key_env_for(model: str) -> str:
    """The environment variable holding the key that pays for ``model``: OpenAI for gpt-*, else Anthropic."""
    return "OPENAI_API_KEY" if model.startswith("gpt-") else "ANTHROPIC_API_KEY"


# The Pip agent is the lean v2 method (ready-made trees and automatic repair) with a choice of model.
PIP_MODELS = ("gpt-6.2-sol", "gpt-6.2-astra", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2")


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
    PIP_AGENT: FableVariant("gpt-6.2-sol", "lean-v2", "OPENAI_API_KEY", models=PIP_MODELS),
    # Pip's first release, before it had a model choice. Kept so its builds can still be opened and
    # changed, but no longer offered for new builds (see RETIRED_AGENTS).
    "fable-lean-v2-gpt-6.2-sol": FableVariant("gpt-6.2-sol", "lean-v2", "OPENAI_API_KEY"),
    "fable-lean-gpt-6.1-sol": FableVariant("gpt-6.1-sol", "lean", "OPENAI_API_KEY"),
}
IN_PROCESS_AGENTS = (ASTROLOGY, *FABLE_AGENTS)
RETIRED_AGENTS = frozenset({"fable-lean-v2-gpt-6.2-sol"})
# What an allowlisted account may pick for a new build, in the order offered.
OFFERED_AGENTS = tuple(agent for agent in IN_PROCESS_AGENTS if agent not in RETIRED_AGENTS)


# Agents whose Generation settings offer example builds: the v2 methods, which are the ones told
# how to use the example builds found for a request.
EXAMPLE_AGENTS = tuple(agent for agent in OFFERED_AGENTS
                       if agent in FABLE_AGENTS and FABLE_AGENTS[agent].method.endswith("-v2"))


def in_process_agent(value) -> str | None:
    """The agent's id when a generation was built here rather than by Nova."""
    return value if isinstance(value, str) and value in IN_PROCESS_AGENTS else None
