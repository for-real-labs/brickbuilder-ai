"""LDraw assembly expansion and software mesh previews, without a CAD executable.

The official library remains the source of geometry, including sloped, curved and
Technic parts. No executable content from an agent or an LDraw file is evaluated.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REFERENCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]*\.(?:dat|ldr)$", re.I)
MAX_FACES = 600_000
MAX_REFERENCE_SOURCE_BYTES = 4 * 1024 * 1024
MAX_REFERENCE_INSTANCES = 10_000
MAX_REFERENCE_COORDINATE = 1_000_000


@dataclass(frozen=True)
class _SourcePlacement:
    colour: int
    position: np.ndarray
    matrix: np.ndarray
    reference: str


@dataclass(frozen=True)
class _SourceFace:
    colour: int
    vertices: np.ndarray


def _source_reference(reference: str) -> str:
    """Normalize an MPD identifier without treating it as a disk path."""
    name = reference.replace("\\", "/")
    if (
        not name or not name.isprintable() or ":" in name or name.startswith("/")
        or any(segment in {"", ".", ".."} for segment in name.split("/"))
        or not name.casefold().endswith((".dat", ".ldr", ".mpd"))
    ):
        raise ValueError("Unsafe source geometry reference")
    return name.casefold()


def _source_values(tokens: list[str]) -> np.ndarray:
    try:
        values = np.asarray([float(token) for token in tokens], dtype=float)
    except (ValueError, OverflowError) as exc:
        raise ValueError("Invalid source geometry coordinates") from exc
    if not np.isfinite(values).all() or np.any(np.abs(values) > MAX_REFERENCE_COORDINATE):
        raise ValueError("Invalid source geometry coordinates")
    return values


def _source_colour(token: str) -> int:
    try:
        colour = _colour_code(token)
    except (ValueError, OverflowError) as exc:
        raise ValueError("Invalid source geometry colour") from exc
    if not 0 <= colour <= 0x3FFFFFF:
        raise ValueError("Invalid source geometry colour")
    return colour


def _source_sections(content: str) -> dict[str, list[_SourcePlacement | _SourceFace]]:
    if not isinstance(content, str):
        raise ValueError("Source geometry must be text")
    try:
        source_bytes = len(content.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ValueError("Invalid source geometry text") from exc
    if source_bytes > MAX_REFERENCE_SOURCE_BYTES:
        raise ValueError("Source geometry exceeds the 4 MB preview budget")

    sections: dict[str, list[_SourcePlacement | _SourceFace]] = {}
    active: str | None = None
    has_files = False
    plain_records: list[_SourcePlacement | _SourceFace] = []
    for raw in content.splitlines():
        line = raw.strip()
        directive = re.fullmatch(r"0\s+FILE\s+(.+)", line, re.I)
        if directive:
            name = _source_reference(directive[1].strip())
            if name in sections:
                raise ValueError("Duplicate source MPD section name")
            if plain_records:
                raise ValueError("Source geometry appears outside an MPD section")
            has_files = True
            active = name
            sections[name] = []
            continue
        if re.fullmatch(r"0\s+NOFILE", line, re.I):
            active = None
            continue
        tokens = line.split(maxsplit=14)
        if not tokens or tokens[0] == "0":
            continue
        if has_files and active is None:
            raise ValueError("Source geometry appears outside an MPD section")
        records = sections[active] if active is not None else plain_records
        if tokens[0] == "1":
            if len(tokens) != 15:
                raise ValueError("Incomplete source geometry placement")
            values = _source_values(tokens[2:14])
            records.append(_SourcePlacement(
                _source_colour(tokens[1]), values[:3], values[3:].reshape(3, 3),
                _source_reference(tokens[14].strip()),
            ))
        elif tokens[0] in {"2", "3", "4", "5"}:
            tokens = line.split()
            vertex_count = {"2": 2, "3": 3, "4": 4, "5": 4}[tokens[0]]
            if len(tokens) != 2 + vertex_count * 3:
                raise ValueError("Incomplete source geometry vertices")
            colour = _source_colour(tokens[1])
            vertices = _source_values(tokens[2:]).reshape(vertex_count, 3)
            if tokens[0] in {"3", "4"}:
                records.append(_SourceFace(colour, vertices))
        else:
            raise ValueError("Invalid source geometry line type")
    if not has_files:
        sections["source.ldr"] = plain_records
    return sections


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

    def render_mpd(
        self, content: str, max_parts: int = MAX_REFERENCE_INSTANCES,
        size: int = 600, two_views: bool = True,
    ) -> tuple[bytes, dict]:
        """Render source MPD geometry using an in-memory FILE namespace.

        Colour 16 remains inherited from the source's explicit wrapper. An
        unwrapped source has unresolved colour 16; no original colour is guessed.
        Part counts include placed library parts and embedded DAT definitions,
        while raw geometry in an LDR section counts as one geometry instance.
        Bounds retain LDraw's original, downward-pointing y coordinates.
        """
        if type(max_parts) is not int or not 1 <= max_parts <= MAX_REFERENCE_INSTANCES:
            raise ValueError("Source part budget must be between 1 and 10,000")
        if type(size) is not int or not 64 <= size <= 2048:
            raise ValueError("Source preview size must be between 64 and 2048")
        if not isinstance(two_views, bool):
            raise ValueError("Source preview view option must be boolean")
        sections = _source_sections(content)
        validated_depths: dict[str, int] = {}
        resolved_references: set[str] = set()

        def validate(name: str, ancestors: tuple[str, ...]) -> int:
            if name in ancestors or len(ancestors) >= 40:
                raise ValueError("Cyclic or excessively nested source geometry")
            if name in validated_depths:
                return validated_depths[name]
            depth = 1
            for record in sections[name]:
                if not isinstance(record, _SourcePlacement):
                    continue
                if record.reference in sections:
                    depth = max(depth, 1 + validate(record.reference, (*ancestors, name)))
                else:
                    # Embedded identifiers never reach the filesystem. Only
                    # missing official DAT references may use the library.
                    if not record.reference.endswith(".dat"):
                        raise ValueError(f"Missing source MPD section: {record.reference}")
                    if record.reference not in resolved_references:
                        self._resolve(record.reference)
                        resolved_references.add(record.reference)
            if depth > 40:
                raise ValueError("Cyclic or excessively nested source geometry")
            validated_depths[name] = depth
            return depth

        # Validate unused FILE definitions as well, rather than silently hiding
        # an invalid or ambiguous namespace outside the selected root.
        for name in sections:
            validate(name, ())

        faces: list[np.ndarray] = []
        colours: list[np.ndarray] = []
        part_count = face_count = instance_count = 0

        def count_part() -> None:
            nonlocal part_count
            part_count += 1
            if part_count > max_parts:
                raise ValueError(f"Source geometry exceeds the {max_parts:,}-part preview budget")

        def append_mesh(mesh: np.ndarray, codes: np.ndarray, matrix: np.ndarray,
                        position: np.ndarray, inherited: int) -> None:
            nonlocal face_count
            face_count += len(mesh)
            if face_count > MAX_FACES:
                raise ValueError("Source geometry exceeds the face preview budget")
            with np.errstate(over="ignore", invalid="ignore"):
                transformed = mesh @ matrix.T + position
            if (
                not np.isfinite(transformed).all()
                or np.any(np.abs(transformed) > MAX_REFERENCE_COORDINATE)
            ):
                raise ValueError("Invalid transformed source geometry coordinates")
            if len(mesh):
                faces.append(transformed)
                colours.append(np.where(codes == 16, inherited, codes))

        def expand(name: str, matrix: np.ndarray, position: np.ndarray,
                   inherited: int, inside_part: bool) -> None:
            nonlocal instance_count
            records = sections[name]
            initial_face_count = face_count
            if not inside_part and any(isinstance(record, _SourceFace) for record in records):
                count_part()
            for record in records:
                colour = inherited if record.colour == 16 else record.colour
                if isinstance(record, _SourceFace):
                    triangles = [record.vertices[:3]]
                    if len(record.vertices) == 4:
                        triangles.append(record.vertices[[0, 2, 3]])
                    mesh = np.asarray(triangles, dtype=float)
                    append_mesh(mesh, np.full(len(mesh), colour, dtype=int), matrix, position, colour)
                    continue
                instance_count += 1
                if instance_count > MAX_REFERENCE_INSTANCES:
                    raise ValueError("Source geometry exceeds the 10,000-instance preview budget")
                with np.errstate(over="ignore", invalid="ignore"):
                    at = position + matrix @ record.position
                    transform = matrix @ record.matrix
                if (
                    not np.isfinite(at).all() or not np.isfinite(transform).all()
                    or np.any(np.abs(at) > MAX_REFERENCE_COORDINATE)
                    or np.any(np.abs(transform) > MAX_REFERENCE_COORDINATE)
                ):
                    raise ValueError("Invalid transformed source geometry coordinates")
                if record.reference in sections:
                    is_part = record.reference.endswith(".dat")
                    if is_part and not inside_part:
                        count_part()
                    expand(record.reference, transform, at, colour, inside_part or is_part)
                else:
                    if not inside_part:
                        count_part()
                    mesh, codes = self._mesh(record.reference)
                    if not len(mesh):
                        raise ValueError(f"Source part has no renderable geometry faces: {record.reference}")
                    append_mesh(mesh, codes, transform, at, colour)
            if name.endswith(".dat") and face_count == initial_face_count:
                raise ValueError(f"Source part has no renderable geometry faces: {name}")

        root = next(iter(sections))
        root_is_part = root.endswith(".dat")
        if root_is_part:
            count_part()
        expand(root, np.eye(3), np.zeros(3), 16, root_is_part)
        if not face_count:
            raise ValueError("The source has no renderable geometry faces")
        triangles, codes = np.concatenate(faces), np.concatenate(colours)
        metadata = {
            "part_count": part_count,
            "triangle_count": face_count,
            "source_instance_count": instance_count,
            "bounds": {
                "min": triangles.min(axis=(0, 1)).tolist(),
                "max": triangles.max(axis=(0, 1)).tolist(),
            },
            "rendered_colours": sorted(int(code) for code in np.unique(codes)),
        }
        return self._render_triangles(triangles, codes, size, two_views), metadata

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
        return self._render_triangles(triangles, codes, size, two_views)

    def _render_triangles(self, triangles: np.ndarray, codes: np.ndarray,
                          size: int, two_views: bool) -> bytes:
        triangles = triangles.copy()
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
