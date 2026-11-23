"""Photograph the actual LDraw placements from two opposing cameras."""

from __future__ import annotations

import io
import math
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageOps


def png(image):
    data = io.BytesIO()
    image.save(data, "PNG")
    return data.getvalue()


@dataclass
class Views:
    front: bytes
    back: bytes

    def review(self):
        board = Image.new("RGB", (1000, 460), "white")
        for i, data in enumerate((self.front, self.back)):
            with Image.open(io.BytesIO(data)) as im:
                im.thumbnail((492, 446), Image.Resampling.LANCZOS)
                board.paste(im, (i * 500 + (500 - im.width) // 2, (460 - im.height) // 2))
        # Keep the two review views small enough to resend alongside the photo.
        data = io.BytesIO()
        board.save(data, "JPEG", quality=85)
        return data.getvalue()


class Renderer:
    def __init__(self):
        self.binary = shutil.which("leocad") or "/Applications/LeoCAD.app/Contents/MacOS/LeoCAD"
        if not Path(self.binary).is_file():
            raise ValueError("Install LeoCAD and put leocad on PATH to render an Astra build")
        self.library = os.getenv("LDRAW_DIR")
        if self.library and not (Path(self.library) / "LDConfig.ldr").is_file():
            raise ValueError("LDRAW_DIR must contain an installed LDraw parts library")

    def __call__(self, model):
        pieces = model.pieces
        low = (
            min(p.x for p in pieces) * 20 - 10,
            min(-(p.y + p.shape.height) * 8 - 4 for p in pieces),
            min(p.z for p in pieces) * 20 - 10,
        )
        high = (
            max(p.x + p.size[0] for p in pieces) * 20 - 10,
            max(-p.y * 8 for p in pieces),
            max(p.z + p.size[1] for p in pieces) * 20 - 10,
        )
        center = [(a + b) / 2 for a, b in zip(low, high)]
        distance = math.dist(low, high) * 2.65
        pictures = []
        with tempfile.TemporaryDirectory(prefix="astra-view-") as tmp:
            source = Path(tmp) / "model.ldr"
            source.write_text(model.ldraw(steps=False), encoding="utf-8")
            for name, direction in (("front", (-0.46, -0.42, -1)), ("back", (0.46, -0.55, 1))):
                eye = [c + d * distance / math.hypot(*direction) for c, d in zip(center, direction)]
                target = Path(tmp) / f"{name}.png"
                command = [self.binary]
                if self.library:
                    command += ["--libpath", self.library]
                command += [
                    "--image",
                    str(target),
                    "--width",
                    "1600",
                    "--height",
                    "1200",
                    "--camera-position-ldraw",
                    *map(str, eye),
                    *map(str, center),
                    "0",
                    "-1",
                    "0",
                    "--fov",
                    "28",
                    "--aa-samples",
                    "4",
                    "--no-highlight",
                    "--no-fade-steps",
                    str(source),
                ]
                subprocess.run(command, check=True, capture_output=True, timeout=90)
                with Image.open(target) as im:
                    rgba = im.convert("RGBA")
                    white = Image.new("RGB", im.size, "white")
                    white.paste(rgba, mask=rgba.getchannel("A"))
                    box = ImageChops.difference(white, Image.new("RGB", im.size, "white")).getbbox()
                    if not box:
                        raise ValueError("LeoCAD produced an empty view")
                    pictures.append(png(ImageOps.expand(white.crop(box), border=24, fill="white")))
        return Views(*pictures)
