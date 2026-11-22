"""Run from backend: python -m experiments.two_pass astra reference.jpg output 'customer prompt'."""

import argparse
import math
import os
from pathlib import Path
import shutil
import subprocess
from PIL import Image, ImageChops
from src.utils.supplier_catalog import get_supplier_catalog
from .agent import run
from .provider import MODELS
from .source import read_source


def render_views(src, out, stage):
    binary = shutil.which("leocad") or "/Applications/LeoCAD.app/Contents/MacOS/LeoCAD"
    positions = [
        list(map(float, l.split()[2:5]))
        for l in src.read_text().splitlines()
        if l.startswith("1 ")
    ]
    lo = [min(axis) - 40 for axis in zip(*positions)]
    hi = [max(axis) + 40 for axis in zip(*positions)]
    center = [(a + b) / 2 for a, b in zip(lo, hi)]
    paths = []
    for angle, vector in [
        ("front-right", (0.44, -0.27, -1)),
        ("back-left", (-0.44, -0.27, 1)),
    ]:
        scale = math.dist(lo, hi) * 3.05 / math.hypot(*vector)
        eye = [a + b * scale for a, b in zip(center, vector)]
        path = out / f"{stage + 1}-{angle}.png"
        subprocess.run(
            [
                binary,
                "--libpath",
                os.environ.get("LDRAW_DIR", str(Path.home() / "ldraw")),
                "--image",
                str(path),
                "--width",
                "1100",
                "--height",
                "850",
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
                str(src),
            ],
            capture_output=True,
            check=True,
            timeout=70,
        )
        with Image.open(path) as im:
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, "white")
            bg.paste(im, mask=im.getchannel("A"))
            box = ImageChops.difference(
                bg, Image.new("RGB", bg.size, "white")
            ).getbbox()
            if box:
                bg = bg.crop(box)
            bg.save(path)
        paths.append(path)
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", choices=MODELS)
    parser.add_argument("reference", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("prompt")
    parser.add_argument("--max-parts", type=int, default=2000)
    parser.add_argument(
        "--source-color",
        type=int,
        help="Limit edit index to an explicitly requested original color",
    )
    args = parser.parse_args()
    if not args.reference.is_file() or not 1 <= args.max_parts <= 2000:
        parser.error("Expected an existing reference and 1..2000 parts")
    rows = None
    index = ""
    views = [args.reference]
    if args.reference.suffix.lower() in (".ldr", ".mpd"):
        rows, index = read_source(args.reference, args.max_parts, args.source_color)
        args.out.mkdir(parents=True, exist_ok=True)
        flat = args.out / "original.ldr"
        with flat.open("x") as handle:
            handle.write("\n".join(rows) + "\n")
        views = render_views(flat, args.out, -1)[:1]
    record = run(
        args.model,
        args.prompt,
        views,
        args.out,
        get_supplier_catalog(),
        args.max_parts,
        render_views,
        rows,
        index,
    )
    print(
        record.get("model", "No model"),
        f"${record['cost']:.4f}",
        record.get("error", ""),
    )


if __name__ == "__main__":
    main()
