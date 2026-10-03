"""LDraw assembly expansion and software mesh previews, without a CAD executable.

The official library remains the source of geometry, including sloped, curved and
Technic parts. No executable content from an agent or an LDraw file is evaluated.
"""
from __future__ import annotations

import io
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REFERENCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]*\.(?:dat|ldr)$", re.I)
MAX_FACES = 600_000


def _colour_code(token: str) -> int:
    return int(token, 16) if token.lower().startswith("0x") else int(token)


def _placement(tokens: list[str]) -> tuple[int, np.ndarray, np.ndarray, str]:
    if len(tokens) != 15 or not REFERENCE_RE.fullmatch(tokens[14]):
        raise ValueError("Invalid or unsafe assembly reference")
    colour = _colour_code(tokens[1])
    values = np.asarray([float(value) for value in tokens[2:14]], dtype=float)
    if colour < 0 or not np.isfinite(values).all() or np.max(np.abs(values)) > 1_000_000:
        raise ValueError("Invalid assembly coordinates or colour")
    return colour, values[:3], values[3:].reshape(3, 3), tokens[14]


def flatten_mpd(content: str, max_parts: int = 5_000) -> str:
    """Expand a generated MPD into official leaf parts for existing storage/BOMs."""
    sections: dict[str, list[str]] = {}
    active = None
    for raw in content.splitlines():
        line = raw.strip()
        if line.upper().startswith("0 FILE "):
            name = line[7:].strip()
            if not REFERENCE_RE.fullmatch(name) or not name.lower().endswith(".ldr"):
                raise ValueError("Unsafe MPD section name")
            active = name.casefold()
            if active in sections:
                raise ValueError("Duplicate MPD section name")
            sections[active] = []
        elif active and not line.upper().startswith("0 NOFILE"):
            sections[active].append(line)
    if not sections:
        raise ValueError("The toolkit did not return an MPD assembly")

    output = ["0 Name: nova-model.ldr", "0 Author: BrickBuilder AI"]
    count = 0

    def expand(name, matrix, position, inherited, ancestors):
        nonlocal count
        if name in ancestors or len(ancestors) >= 40:
            raise ValueError("Cyclic or excessively nested assembly")
        for line in sections[name]:
            tokens = line.split()
            if not tokens:
                continue
            if tokens[0] == "0":
                if line.upper() == "0 STEP":
                    output.append("0 STEP")
                continue
            if tokens[0] != "1":
                raise ValueError("Generated assemblies may only contain part placements")
            colour, offset, rotation, reference = _placement(tokens)
            colour = inherited if colour == 16 else colour
            at, transform = position + matrix @ offset, matrix @ rotation
            key = reference.casefold()
            if key in sections:
                expand(key, transform, at, colour, (*ancestors, name))
            else:
                if not key.endswith(".dat"):
                    raise ValueError(f"Missing assembly section: {reference}")
                count += 1
                if count > max_parts:
                    raise ValueError(f"The assembly exceeds the {max_parts:,}-part limit")
                numbers = " ".join(format(float(value), ".9g") for value in (*at, *transform.flat))
                output.append(f"1 {colour} {numbers} {reference}")

    expand(next(iter(sections)), np.eye(3), np.zeros(3), 7, ())
    if not count:
        raise ValueError("The assembly has no physical parts")
    return "\n".join(output) + "\n"


class LDrawMeshRenderer:
    """Render real library triangles with bounded recursion and face counts."""

    def __init__(self, library: Path):
        self.library = library.resolve()

    def _resolve(self, reference: str) -> Path:
        name = reference.replace("\\", "/").lower()
        if name.startswith("/") or any(part in {"", ".", ".."} for part in name.split("/")):
            raise ValueError("Unsafe library geometry reference")
        # The low resolution primitives are official geometry, and make large
        # models practical to review without losing any physical parts.
        roots = (self.library / "p" / "8", self.library / "parts", self.library / "p")
        for root in roots:
            path = (root / name).resolve()
            if path.is_relative_to(self.library) and path.is_file():
                return path
        raise ValueError(f"Library geometry missing: {reference}")

    @lru_cache(maxsize=256)
    def _mesh(self, reference: str, ancestors: tuple[str, ...] = ()) -> tuple[np.ndarray, np.ndarray]:
        key = reference.replace("\\", "/").lower()
        if key in ancestors or len(ancestors) > 40:
            raise ValueError("Cyclic library geometry")
        faces, colours = [], []
        for line in self._resolve(reference).read_text(encoding="utf-8-sig", errors="replace").splitlines():
            tokens = line.split()
            if not tokens or tokens[0] not in {"1", "3", "4"}:
                continue
            try:
                colour = _colour_code(tokens[1])
                if tokens[0] == "1":
                    if len(tokens) < 15:
                        raise ValueError("Incomplete geometry placement")
                    values = np.asarray([float(v) for v in tokens[2:14]])
                    nested, nested_colours = self._mesh(" ".join(tokens[14:]), (*ancestors, key))
                    transformed = nested @ values[3:].reshape(3, 3).T + values[:3]
                    faces.extend(transformed)
                    colours.extend(np.where(nested_colours == 16, colour, nested_colours))
                else:
                    vertices = np.asarray([float(v) for v in tokens[2:]], dtype=float).reshape(-1, 3)
                    faces.append(vertices[:3])
                    colours.append(colour)
                    if tokens[0] == "4":
                        faces.append(vertices[[0, 2, 3]])
                        colours.append(colour)
                if len(faces) > MAX_FACES:
                    raise ValueError("Part geometry exceeds the preview budget")
            except (IndexError, TypeError) as exc:
                raise ValueError("Invalid library geometry") from exc
        return np.asarray(faces, dtype=float).reshape(-1, 3, 3), np.asarray(colours, dtype=int)

    def _palette(self) -> dict[int, tuple[int, int, int]]:
        palette = {}
        for line in (self.library / "LDConfig.ldr").read_text(errors="replace").splitlines():
            match = re.search(r"CODE\s+(\d+)\s+VALUE\s+#([0-9a-f]{6})", line, re.I)
            if match:
                palette[int(match[1])] = tuple(int(match[2][i:i + 2], 16) for i in (0, 2, 4))
        return palette

    def render(self, ldr: str, size: int = 600, two_views: bool = True) -> bytes:
        faces, colours = [], []
        face_count = 0
        for line in ldr.splitlines():
            tokens = line.split()
            if not tokens or tokens[0] != "1":
                continue
            colour, at, matrix, reference = _placement(tokens)
            mesh, codes = self._mesh(reference)
            face_count += len(mesh)
            if face_count > MAX_FACES:
                raise ValueError("Model geometry exceeds the preview budget; inspect smaller subassemblies")
            faces.append(mesh @ matrix.T + at)
            colours.append(np.where(codes == 16, colour, codes))
        if not faces or not face_count:
            raise ValueError("The model has no renderable library faces")
        triangles = np.concatenate(faces)
        codes = np.concatenate(colours)
        triangles[..., 1] *= -1  # LDraw's y axis points down.
        if not np.isfinite(triangles).all():
            raise ValueError("Non-finite geometry")
        palette = self._palette()
        def rgb_for(code):
            code = int(code)
            if code in palette:
                return palette[code]
            if 0x2000000 <= code <= 0x3FFFFFF:
                return (code >> 16 & 255, code >> 8 & 255, code & 255)
            return (145, 145, 145)

        rgb = np.asarray([rgb_for(code) for code in codes], dtype=float)
        normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
        lengths = np.linalg.norm(normals, axis=1)
        normals /= np.maximum(lengths[:, None], 1e-9)
        light = np.array([-.4, .85, -.3])
        shaded = np.clip(rgb * (.55 + .4 * np.abs(normals @ light))[:, None], 0, 255).astype(int)
        views = [(1., .8, 1.)]
        if two_views:
            views.append((-1., .8, -1.))
        canvas = Image.new("RGB", (size * len(views), size), "#f3f5f8")
        for index, direction in enumerate(views):
            forward = np.asarray(direction) / np.linalg.norm(direction)
            right = np.cross([0., 1., 0.], forward)
            right /= np.linalg.norm(right)
            up = np.cross(forward, right)
            projected = np.stack((triangles @ right, -(triangles @ up)), axis=-1)
            mins, maxs = projected.min(axis=(0, 1)), projected.max(axis=(0, 1))
            scale = (size * .86) / max(float(np.max(maxs - mins)), 1.)
            projected = (projected - (mins + maxs) / 2) * scale + [size / 2 + index * size, size / 2]
            order = np.argsort(np.mean(triangles @ forward, axis=1))
            draw = ImageDraw.Draw(canvas)
            for face_index in order:
                draw.polygon([tuple(point) for point in projected[face_index]], fill=tuple(shaded[face_index]))
        output = io.BytesIO()
        canvas.save(output, format="PNG")
        return output.getvalue()
