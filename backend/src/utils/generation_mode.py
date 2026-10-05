"""Public composer mode values persisted with generation revisions."""
from typing import Literal

GenerationMode = Literal['basic_bricks', 'all_parts']
INHERITED_MODE_ENDPOINTS = {'updateModel', 'resizeModel', 'promptEditModel'}


def generation_mode(endpoint: str | None, saved: str | None = None) -> GenerationMode:
    if saved in ('basic_bricks', 'all_parts'):
        return saved
    return 'all_parts' if endpoint == 'novaToBricks' else 'basic_bricks'
