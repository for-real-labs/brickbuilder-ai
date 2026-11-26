"""Nova's publication rules, loaded from ``nova-service`` so both agents share one copy.

Nova blocks a model whose solid plastic intersects or whose pieces cannot be added one at a time,
and it writes instructions in small connected steps. Those rules are plain Python over part
positions and contacts, so a Fable build can be put through the very same code: a fix made for
Nova reaches Fable without being copied. Only the evidence differs. Nova gets its contacts from
its own toolkit; Fable supplies the ones its checker measured.
"""

from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from types import ModuleType, SimpleNamespace

from .kit import Placement

RULES_DIR = Path(__file__).resolve().parents[1] / "nova-service"


class RulesUnavailable(RuntimeError):
    """The shared rule files are missing from this installation."""


def _load(name: str, filename: str) -> ModuleType:
    path = RULES_DIR / filename
    if not path.is_file():
        raise RulesUnavailable(f"Nova's rule file {filename} is not installed next to fable_agent")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # material_surfaces imports material_collision by this name
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


@lru_cache(maxsize=1)
def nova_rules() -> SimpleNamespace:
    """``sequence`` (building order), ``material`` (solid plastic) and ``surfaces`` (exposed parts)."""
    material = sys.modules.get("material_collision") or _load("material_collision", "material_collision.py")
    return SimpleNamespace(sequence=_load("brickbuilder_nova_flatten", "flatten.py"), material=material,
                           surfaces=_load("brickbuilder_nova_material_surfaces", "material_surfaces.py"))


@dataclass(frozen=True)
class _Point:
    x: float
    y: float
    z: float


@dataclass(frozen=True)
class _Matrix:
    rows: tuple[tuple[float, float, float], ...]


@dataclass(frozen=True)
class Occurrence:
    """One placed part in the shape Nova's rules read: a code, a position and a rotation."""

    part_code: str
    position: _Point
    matrix: _Matrix


def occurrence(placement: Placement) -> Occurrence:
    m = placement.matrix
    return Occurrence(placement.part, _Point(*placement.position), _Matrix((m[0:3], m[3:6], m[6:9])))
