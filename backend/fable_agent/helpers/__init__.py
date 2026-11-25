"""Helpers: ready-made pieces of a model that a build script gets with one call.

Each helper lives in its own module and exports ``HELPER`` (or ``HELPERS`` for several). Add a module to ``_MODULES`` and it
reaches build scripts, the v2 prompts and the tests at once. How to write one is in
``.agents/skills/fable-helpers/SKILL.md``.
"""

from __future__ import annotations

from importlib import import_module
from inspect import signature

from ..kit import KitError
from .common import Helper

_MODULES = ("trees", "roofs", "walls", "windows", "doors", "arches", "decks", "stairs", "railings", "cars", "vehicles", "furniture", "props")
HELPERS: dict[str, Helper] = {}
for _name in _MODULES:
    _module = import_module(f"{__name__}.{_name}")
    for _helper in getattr(_module, "HELPERS", None) or (_module.HELPER,):  # a module may hold several helpers
        HELPERS[_helper.name] = _helper


def bind(kit) -> dict:
    """The helpers as build scripts call them: each one bound to this build's kit."""
    return {name: _bound(kit, helper) for name, helper in HELPERS.items()}


def _bound(kit, helper: Helper):
    takes = signature(helper.build)

    def call(*args, **kwargs):
        try:
            takes.bind(kit, *args, **kwargs)
        except TypeError:  # too many arguments, or one the helper does not have: say how it is called
            raise KitError(f"{helper.name}() does not take those arguments. Call it as {helper.signature}") from None
        return helper.build(kit, *args, **kwargs)

    call.__name__ = helper.name
    return call


def prompt_section() -> str:
    """What the v2 prompts tell the model about the helpers."""
    lines = []
    for helper in HELPERS.values():
        notes = helper.notes or {}
        styles = ", ".join(f"{style} ({notes[style]})" if style in notes else style for style in helper.styles)
        lines.append(f"- `{helper.signature}`: {helper.summary} Styles: {styles}.")
    return "\n".join(lines)
