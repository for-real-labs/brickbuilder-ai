"""Export Google Play assets from the existing App Store artwork.

Run with the same Pillow/numpy environment as render.py. The original iOS
screenshots stay intact; padding adapts their aspect ratio without cropping UI.
"""

import shutil

from PIL import Image, ImageDraw

import render as design


OUTPUT = design.STORE.parent / "google-play"
PHONE_SIZE = (1080, 1920)
FEATURE_SIZE = (1024, 500)


def phone_screenshot(source):
    width = round(source.height * PHONE_SIZE[0] / PHONE_SIZE[1])
    canvas = Image.new("RGB", (width, source.height), design.NAVY)
    canvas.paste(source.convert("RGB"), ((width - source.width) // 2, 0))
    return canvas.resize(PHONE_SIZE, Image.Resampling.LANCZOS)


def feature_graphic():
    # Render at 2x for smooth typography and reuse the original model render.
    canvas = Image.new("RGBA", (2048, 1000), (*design.NAVY, 255))
    draw = ImageDraw.Draw(canvas)
    draw.polygon(((0, 780), (2048, 540), (2048, 1000), (0, 1000)), fill=design.CORAL)
    design.text(draw, (150, 170), "Dream it.", 132)
    design.text(draw, (150, 325), "Brick it.", 132, design.CORAL)
    design.text(draw, (155, 525), "Photos and text become", 45, design.MUTED, 500)
    design.text(draw, (155, 588), "LEGO-compatible 3D models.", 45, design.MUTED, 500)
    design.hero(canvas, (1110, 120, 790, 710))
    return canvas.convert("RGB").resize(FEATURE_SIZE, Image.Resampling.LANCZOS)


def main():
    images = OUTPUT / "graphics"
    phones = images / "phone"
    phones.mkdir(parents=True, exist_ok=True)
    for name in design.FILENAMES:
        with Image.open(design.STORE / "screenshots/iphone-6.5" / name) as source:
            phone_screenshot(source).save(phones / name, optimize=True)
    with Image.open(design.STORE.parent / "assets/icon.png") as source:
        source.convert("RGBA").resize((512, 512), Image.Resampling.LANCZOS).save(
            images / "icon.png", optimize=True
        )
    feature_graphic().save(images / "feature-graphic.png", optimize=True)
    metadata = OUTPUT / "metadata/en-US"
    metadata.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(design.STORE / "metadata/en-US/description.txt", metadata / "full-description.txt")
    print(f"Exported Google Play artwork and matching iOS description to {OUTPUT}")


if __name__ == "__main__":
    main()
