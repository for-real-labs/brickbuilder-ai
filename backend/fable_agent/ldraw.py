"""Read-only access to an LDraw parts library: files, colors and flattened geometry."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

PART_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")
MAX_REFERENCE_DEPTH = 24
MAX_PART_TRIANGLES = 400_000


class LDrawError(ValueError):
    """The library is missing, or a part cannot be read from it."""


@dataclass(frozen=True)
class Color:
    code: int
    name: str
    hex: str
    transparent: bool


@dataclass(frozen=True)
class PartGeometry:
    """Triangles of the part body and the frames of its studs, in part-local LDU."""

    triangles: np.ndarray  # (n, 3, 3) float64, studs excluded
    studs: np.ndarray  # (m, 6) float64: base position then outward direction


def normalize_part_id(value: str) -> str:
    text = str(value).strip().lower().replace("\\", "/")
    if text.startswith("parts/"):
        text = text[6:]
    if text.endswith(".dat"):
        text = text[:-4]
    if not PART_ID.fullmatch(text):
        raise LDrawError(f"Invalid LDraw part identifier: {str(value)[:40]!r}")
    return text


def default_library_dir() -> Path:
    for name in ("LDRAW_DIR", "LDRAWDIR"):
        if os.environ.get(name):
            return Path(os.environ[name]).expanduser()
    return Path.home() / "ldraw"


class LDrawLibrary:
    """Resolves and parses library files. Never writes to the library."""

    def __init__(self, root: Path | str | None = None):
        self.root = Path(root).expanduser() if root else default_library_dir()
        if not (self.root / "parts").is_dir():
            raise LDrawError(f"No LDraw library found at {self.root} (set LDRAW_DIR)")
        self._parsed: dict[str, tuple[list, list]] = {}
        self._flat: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        self._descriptions: dict[str, str] = {}
        self._stud_primitive: dict[str, bool] = {}
        self._colors: dict[int, Color] | None = None

    # ----- files ---------------------------------------------------------

    def _resolve(self, reference: str) -> Path | None:
        name = reference.strip().lower().replace("\\", "/")
        if not name or name.startswith("/") or ".." in name.split("/"):
            return None
        for folder in ("parts", "p"):
            path = self.root / folder / name
            if path.is_file():
                return path
        return None

    def has_part(self, part_id: str) -> bool:
        return (self.root / "parts" / f"{part_id}.dat").is_file()

    def part_ids(self) -> list[str]:
        return sorted(p.stem.lower() for p in (self.root / "parts").glob("*.dat"))

    def description(self, part_id: str) -> str:
        if part_id not in self._descriptions:
            path = self.root / "parts" / f"{part_id}.dat"
            text = ""
            if path.is_file():
                with path.open(encoding="utf-8", errors="replace") as handle:
                    first = handle.readline().strip()
                if first.startswith("0"):
                    text = " ".join(first[1:].split())
            moved = re.fullmatch(r"~Moved to (\S+)", text)
            if moved and moved.group(1).lower() != part_id:
                self._descriptions[part_id] = ""  # guards against a reference cycle
                text = self.description(moved.group(1).lower()) or text
            self._descriptions[part_id] = text
        return self._descriptions[part_id]

    def colors(self) -> dict[int, Color]:
        if self._colors is None:
            colors: dict[int, Color] = {}
            config = self.root / "LDConfig.ldr"
            if config.is_file():
                for line in config.read_text(encoding="utf-8", errors="replace").splitlines():
                    tokens = line.split()
                    if tokens[:2] != ["0", "!COLOUR"] or "CODE" not in tokens or "VALUE" not in tokens:
                        continue
                    try:
                        code = int(tokens[tokens.index("CODE") + 1])
                        value = tokens[tokens.index("VALUE") + 1]
                    except (ValueError, IndexError):
                        continue
                    colors[code] = Color(code, tokens[2], value.upper(), "ALPHA" in tokens)
            self._colors = colors
        return self._colors

    # ----- geometry ------------------------------------------------------

    def _parse(self, path: Path) -> tuple[list, list]:
        key = str(path)
        if key in self._parsed:
            return self._parsed[key]
        references: list[tuple[np.ndarray, np.ndarray, str]] = []
        triangles: list[list[float]] = []
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                tokens = line.split()
                if not tokens:
                    continue
                kind = tokens[0]
                try:
                    if kind == "1" and len(tokens) >= 15:
                        v = [float(t) for t in tokens[2:14]]
                        matrix = np.array([v[3:6], v[6:9], v[9:12]])
                        references.append((matrix, np.array(v[0:3]), " ".join(tokens[14:])))
                    elif kind == "3" and len(tokens) >= 11:
                        triangles.append([float(t) for t in tokens[2:11]])
                    elif kind == "4" and len(tokens) >= 14:
                        v = [float(t) for t in tokens[2:14]]
                        triangles.append(v[0:9])
                        triangles.append(v[0:3] + v[6:12])
                except ValueError:
                    continue
        self._parsed[key] = (references, triangles)
        return self._parsed[key]

    def _is_stud(self, path: Path) -> bool:
        """Top studs are connectors; underside tubes belong to the body."""
        key = str(path)
        if key not in self._stud_primitive:
            answer = False
            if path.name.startswith("stud") and path.parent.name in {"p", "8", "48"}:
                with path.open(encoding="utf-8", errors="replace") as handle:
                    text = handle.readline()[1:].strip().lower()
                answer = text.startswith("stud") and not any(
                    word in text for word in ("tube", "underside", "placeholder", "duplo", "scala", "quatro")
                )
            self._stud_primitive[key] = answer
        return self._stud_primitive[key]

    def _flatten(self, path: Path, depth: int) -> tuple[np.ndarray, np.ndarray]:
        key = str(path)
        if key in self._flat:
            return self._flat[key]
        if depth > MAX_REFERENCE_DEPTH:
            raise LDrawError("LDraw reference nesting is too deep")
        references, own = self._parse(path)
        parts = [np.array(own, dtype=np.float64).reshape(-1, 3, 3)]
        studs = [np.zeros((0, 6))]
        for matrix, offset, name in references:
            child = self._resolve(name)
            if child is None:
                continue
            if self._is_stud(child):
                direction = matrix @ np.array([0.0, -1.0, 0.0])
                length = np.linalg.norm(direction)
                if length > 1e-9:
                    studs.append(np.concatenate([offset, direction / length])[None, :])
                continue
            child_triangles, child_studs = self._flatten(child, depth + 1)
            if len(child_triangles):
                parts.append(child_triangles @ matrix.T + offset)
            if len(child_studs):
                positions = child_studs[:, :3] @ matrix.T + offset
                directions = child_studs[:, 3:] @ matrix.T
                norms = np.linalg.norm(directions, axis=1, keepdims=True)
                studs.append(np.hstack([positions, directions / np.where(norms > 1e-9, norms, 1)]))
        triangles = np.concatenate(parts)
        if len(triangles) > MAX_PART_TRIANGLES:
            raise LDrawError("Part geometry is too large to analyze")
        self._flat[key] = (triangles, np.concatenate(studs))
        return self._flat[key]

    def geometry(self, part_id: str) -> PartGeometry:
        path = self.root / "parts" / f"{part_id}.dat"
        if not path.is_file():
            raise LDrawError(f"Part {part_id} is not in the LDraw library")
        triangles, studs = self._flatten(path, 0)
        if not len(triangles):
            raise LDrawError(f"Part {part_id} has no geometry")
        return PartGeometry(triangles, studs)
