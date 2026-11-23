"""Render a thumbnail from the saved LDraw revision."""

import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore

from PIL import Image

from fable_agent.ldraw import default_library_dir
from fable_agent.render import find_leocad

from .ldraw_upload import normalize_ldraw_upload

_render_slots = BoundedSemaphore(2)
_geometry_metadata = {"FILE", "NOFILE", "BFC", "!COLOUR"}


def render_generation_preview(model: bytes) -> bytes:
    # Keep model sections, geometry and colors. Drop renderer directives for
    # external textures, saved cameras, hidden pieces, and construction steps.
    lines = []
    for line in normalize_ldraw_upload("model.mpd", model, max_expanded_geometry=1_000_000).splitlines():
        fields = line.split(maxsplit=2)
        if fields and (fields[0] != "0" or (len(fields) > 1 and fields[1].upper() in _geometry_metadata)):
            lines.append(line)

    binary = find_leocad()
    if not binary:
        raise ValueError("LeoCAD is unavailable for preview rendering")

    with _render_slots, TemporaryDirectory(prefix="brickbuilder-preview-") as directory:
        source = Path(directory) / "model.mpd"
        source.write_text("\n".join(lines) + "\n", encoding="utf-8")
        target = Path(directory) / "preview.png"
        subprocess.run(
            [binary, "--libpath", str(default_library_dir()), "--image", str(target),
             "--width", "480", "--height", "480", "--viewpoint", "home",
             "--aa-samples", "4", "--no-highlight", "--no-fade-steps", str(source)],
            cwd=directory,
            env={key: os.environ[key] for key in ("PATH", "DISPLAY", "LANG") if key in os.environ},
            check=True,
            capture_output=True,
            timeout=25,
        )
        with Image.open(target) as image:
            if not image.convert("RGBA").getchannel("A").getbbox():
                raise ValueError("LeoCAD produced an empty preview")
        return target.read_bytes()
