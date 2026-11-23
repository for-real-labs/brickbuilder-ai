"""Pictures of a model for visual review. LeoCAD draws; this module aims the camera."""

from __future__ import annotations

import math
import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol, Sequence

from PIL import Image, ImageDraw

VIEW_AZIMUTH = {
    "front": 0, "front-right": 40, "right": 90, "back-right": 140,
    "back": 180, "back-left": 220, "left": 270, "front-left": 320, "top": 0,
}
FIELD_OF_VIEW = 30.0
BACKGROUND = (244, 245, 247)
MAX_SIDE = 1024
_MAC_BINARY = "/Applications/LeoCAD.app/Contents/MacOS/LeoCAD"


class RenderError(RuntimeError):
    """Rendering is unavailable or failed; the message is safe to show the agent."""


@dataclass(frozen=True)
class RenderedView:
    name: str
    path: Path


def camera(bounds: Sequence[float], view: str, elevation: float | None = None) -> tuple[list[float], list[float]]:
    """Eye and target in LDraw coordinates (Y down) framing ``bounds`` from ``view``."""
    if view not in VIEW_AZIMUTH:
        raise RenderError(f"Unknown view {view!r}; choose from {', '.join(VIEW_AZIMUTH)}")
    lo, hi = bounds[:3], bounds[3:]
    target = [(a + b) / 2 for a, b in zip(lo, hi)]
    radius = max(20.0, math.dist(lo, hi) / 2)
    tilt = math.radians(88.0 if view == "top" else 24.0 if elevation is None else max(-10.0, min(88.0, elevation)))
    turn = math.radians(VIEW_AZIMUTH[view])
    direction = (math.sin(turn) * math.cos(tilt), -math.sin(tilt), -math.cos(turn) * math.cos(tilt))
    distance = radius / math.sin(math.radians(FIELD_OF_VIEW) / 2) * 1.06
    return [t + d * distance for t, d in zip(target, direction)], target


class Renderer(Protocol):
    def render(self, model: Path, out_dir: Path, views: Sequence[str], bounds: Sequence[float], *,
               prefix: str = "view", elevation: float | None = None) -> list[RenderedView]: ...


def find_leocad() -> str | None:
    configured = os.environ.get("LEOCAD_BIN")
    if configured:
        return configured
    return shutil.which("leocad") or (_MAC_BINARY if Path(_MAC_BINARY).is_file() else None)


def _finish(path: Path) -> None:
    """Flatten transparency, trim empty margins and bound the size sent to the model."""
    with Image.open(path) as source:
        image = source.convert("RGBA")
    box = image.getbbox()
    flat = Image.new("RGB", image.size, BACKGROUND)
    flat.paste(image, mask=image.getchannel("A"))
    if box:
        pad = 28
        flat = flat.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                          min(image.width, box[2] + pad), min(image.height, box[3] + pad)))
    flat.thumbnail((MAX_SIDE, MAX_SIDE))
    flat.save(path, "PNG", optimize=True)


class LeoCadRenderer:
    def __init__(self, ldraw_dir: Path | str, binary: str | None = None, *, size: tuple[int, int] = (1280, 960),
                 run: Callable[..., subprocess.CompletedProcess] = subprocess.run, timeout: int = 180):
        self._ldraw_dir = str(ldraw_dir)
        self._binary = binary or find_leocad()
        self._size = size
        self._run = run
        self._timeout = timeout

    def _one(self, model: Path, target_file: Path, view: str, bounds: Sequence[float], elevation: float | None) -> None:
        eye, target = camera(bounds, view, elevation)
        up = ["0", "0", "1"] if view == "top" else ["0", "-1", "0"]
        command = [self._binary, "-l", self._ldraw_dir, "-i", str(target_file),
                   "-w", str(self._size[0]), "-h", str(self._size[1]),
                   "--camera-position-ldraw", *(f"{v:.2f}" for v in (*eye, *target)), *up,
                   "--fov", f"{FIELD_OF_VIEW:g}", "--aa-samples", "4", str(model)]
        try:
            completed = self._run(command, capture_output=True, timeout=self._timeout, check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            raise RenderError(f"The renderer could not run: {type(exc).__name__}") from None
        if completed.returncode != 0 or not target_file.is_file():
            raise RenderError("The renderer did not produce an image")
        _finish(target_file)

    def render(self, model: Path, out_dir: Path, views: Sequence[str], bounds: Sequence[float], *,
               prefix: str = "view", elevation: float | None = None) -> list[RenderedView]:
        if not self._binary:
            raise RenderError("LeoCAD is not installed. Install it or set LEOCAD_BIN to its executable.")
        if not views:
            raise RenderError("Choose at least one view")
        out_dir.mkdir(parents=True, exist_ok=True)
        results = [RenderedView(view, out_dir / f"{prefix}-{view}.png") for view in views]
        with ThreadPoolExecutor(max_workers=min(4, len(results))) as pool:
            jobs = [pool.submit(self._one, model, item.path, item.name, bounds, elevation) for item in results]
            for job in jobs:
                job.result()
        return results


def contact_sheet(tiles: Sequence[tuple[str, Path]], target: Path, columns: int = 4) -> Path:
    """One labelled image from several small renders (used to compare candidate parts)."""
    cell, label = 250, 34
    columns = max(1, min(columns, len(tiles)))
    rows = math.ceil(len(tiles) / columns)
    sheet = Image.new("RGB", (columns * cell, rows * (cell + label)), BACKGROUND)
    draw = ImageDraw.Draw(sheet)
    for index, (caption, path) in enumerate(tiles):
        left, top = (index % columns) * cell, (index // columns) * (cell + label)
        with Image.open(path) as picture:
            thumb = picture.convert("RGB")
        thumb.thumbnail((cell - 16, cell - 16))
        sheet.paste(thumb, (left + (cell - thumb.width) // 2, top + (cell - thumb.height) // 2))
        draw.text((left + 8, top + cell + 8), caption[:38], fill=(20, 24, 30))
    sheet.save(target, "PNG", optimize=True)
    return target
