"""Public composer mode values persisted with generation revisions."""
from typing import Literal

from .building_agents import PIP_ENDPOINT

ALL_PARTS_AGENT_ENDPOINTS = ("novaToBricks", PIP_ENDPOINT)

GenerationMode = Literal['basic_bricks', 'all_parts']
INHERITED_MODE_ENDPOINTS = {'updateModel', 'resizeModel', 'promptEditModel'}


def generation_mode(endpoint: str | None, saved: str | None = None) -> GenerationMode:
    if saved in ('basic_bricks', 'all_parts'):
        return saved
    return 'all_parts' if endpoint in (*ALL_PARTS_AGENT_ENDPOINTS, 'uploadLdraw') else 'basic_bricks'
