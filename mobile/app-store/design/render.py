"""Render three connected App Store posters from unmodified app captures.

Requires Pillow and numpy. Run from any directory: python render.py
"""

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import math
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parent
STORE = ROOT.parent
WIDTH = 1242
NAVY = (15, 23, 38)
WHITE = (250, 248, 242)
CORAL = (255, 100, 85)
MUTED = (179, 191, 205)


@dataclass(frozen=True)
class Export:
    folder: str
    width: int
    height: int
    tablet: bool = False


EXPORTS = (
    Export("iphone-6.3", 1206, 2622),
    Export("iphone-6.5", 1242, 2688),
    Export("iphone-6.9", 1320, 2868),
    Export("ipad-13", 2064, 2752, True),
)
FILENAMES = ("01-imagine.png", "02-create.png", "03-explore.png")
HEADLINES = (("Dream it.", "Brick it."), ("Make it", "uniquely yours."), ("Find your", "next build."))
DESCRIPTIONS = (
    ("Turn photos or text into", "LEGO-compatible 3D models."),
    ("Refine LEGO-compatible models.", "Make every detail your own."),
    ("Discover LEGO-compatible builds.", "Get inspired by the community."),
)
LABELS = ("01  IMAGINE", "02  CREATE", "03  EXPLORE")
SOURCES = {
    "iphone-create.png": (436, 185),
    "iphone-model.png": (428, 654),
    "community-search.png": (428, 93),
    "ipad-create.png": (815, 130),
    "ipad-model.png": (428, 384),
    "ipad-refine.png": (428, 255),
}


@lru_cache(maxsize=64)
def font(size, weight=800):
    result = ImageFont.truetype(str(ROOT / "fonts/Manrope.ttf"), size)
    result.set_variation_by_axes([weight])
    return result


def text(draw, position, value, size, fill=WHITE, weight=800):
    draw.text(position, value, font=font(size, weight), fill=fill, anchor="lt")


def load_source(name):
    # Keep only focused, already-cropped app UI; omit account/header information.
    image = Image.open(ROOT / "sources" / name).convert("RGB")
    if image.size != SOURCES[name]:
        raise ValueError(f"Unexpected capture dimensions: {name}")
    return image


def background(height):
    """One panorama, split only after rendering, keeps every seam continuous."""
    width = WIDTH * 3
    yy, xx = np.mgrid[0:height, 0:width]
    glow = np.exp(-(((xx - width * .52) / (width * .8)) ** 2 + ((yy - height * .55) / (height * .65)) ** 2))
    pixels = np.empty((height, width, 3), dtype=np.uint8)
    for channel, base in enumerate(NAVY):
        pixels[:, :, channel] = base + glow * (9, 12, 15)[channel]
    canvas = Image.fromarray(pixels).convert("RGBA")
    draw = ImageDraw.Draw(canvas)
    # A wide warm ribbon travels behind the app previews, joining at every edge.
    centers = [(x, int(height * .76 + math.sin(x / 615 + .7) * height * .10)) for x in range(-20, width + 22, 3)]
    radius = int(height * .085)
    polygon = [(x, y - radius) for x, y in centers] + [(x, y + radius) for x, y in reversed(centers)]
    draw.polygon(polygon, fill=(235, 91, 77))
    draw.line([(x, y - radius + 14) for x, y in centers], fill=(255, 141, 113), width=3)
    # Large subtle stud outlines add a brick motif without competing with copy.
    for x, y, r in ((-80, height * .43, 245), (WIDTH + 50, height * .32, 220), (WIDTH * 2 + 30, height * .51, 260), (width - 90, height * .24, 210)):
        draw.ellipse((x-r, y-r, x+r, y+r), outline=(42, 56, 72), width=2)
        draw.ellipse((x-r+20, y-r+20, x+r-20, y+r-20), outline=(35, 48, 65), width=2)
    return canvas


def rounded_paste(canvas, content, xy, radius=38):
    mask = Image.new("L", content.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, content.width-1, content.height-1), radius, fill=255)
    canvas.paste(content, xy, mask)


def app_card(canvas, source, xy, width, max_height=None):
    height = round(source.height * width / source.width)
    if max_height and height > max_height:
        width = round(width * max_height / height)
        height = max_height
    shot = source.resize((width, height), Image.Resampling.LANCZOS)
    x, y = xy
    padding = 15
    box = (x-padding, y-padding, x+width+padding, y+height+padding)
    shadow = Image.new("RGBA", canvas.size)
    ImageDraw.Draw(shadow).rounded_rectangle((box[0]-4, box[1]+28, box[2]+4, box[3]+36), 60, fill=(0, 0, 0, 125))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(35)))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(box, 53, fill=(225, 230, 233), outline=(255, 255, 255), width=2)
    rounded_paste(canvas, shot, (x, y), 39)
    return (x, y, width, height)


def pill(canvas, xy, value, size=29):
    draw = ImageDraw.Draw(canvas)
    width = math.ceil(draw.textlength(value, font=font(size, 700))) + 56
    x, y = xy
    draw.rounded_rectangle((x, y, x+width, y+68), 34, fill=(40, 54, 70), outline=(75, 90, 106), width=2)
    text(draw, (x+28, y+20), value, size, WHITE, 700)


def brick(canvas, xy, scale=1, color=CORAL, angle=-15):
    """A small code-drawn isometric brick, used only as background artwork."""
    tile = Image.new("RGBA", (320, 250))
    d = ImageDraw.Draw(tile)
    top = tuple(min(255, int(v*1.12)) for v in color)
    side = tuple(int(v*.68) for v in color)
    d.polygon(((40, 110), (155, 50), (280, 110), (165, 175)), fill=top)
    d.polygon(((40, 110), (165, 175), (165, 225), (40, 160)), fill=color)
    d.polygon(((165, 175), (280, 110), (280, 160), (165, 225)), fill=side)
    for cx, cy in ((122, 90), (181, 119)):
        d.ellipse((cx-27,cy-9,cx+27,cy+20), fill=side)
        d.ellipse((cx-27,cy-20,cx+27,cy+7), fill=top, outline=color, width=2)
    tile = tile.resize((round(320*scale), round(250*scale)), Image.Resampling.LANCZOS).rotate(angle, Image.Resampling.BICUBIC, expand=True)
    canvas.alpha_composite(tile, xy)


def hero(canvas, box):
    source = Image.open(ROOT / "sources/knapp-center.png").convert("RGBA")
    source = source.crop(source.getbbox())
    source = ImageOps.contain(source, (box[2], box[3]), Image.Resampling.LANCZOS)
    x = box[0] + (box[2]-source.width)//2
    y = box[1] + (box[3]-source.height)//2
    shadow = Image.new("RGBA", canvas.size)
    d = ImageDraw.Draw(shadow)
    d.ellipse((x+source.width*.08, y+source.height-60, x+source.width*.92, y+source.height+20), fill=(0, 0, 0, 140))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(32)))
    canvas.alpha_composite(source, (x, y))


def community_feature(width, height):
    """Marketing artwork using the unmodified original community model image."""
    card = Image.new("RGBA", (width, height), (245, 247, 250, 255))
    source = Image.open(ROOT / "sources/bat-cave.png").convert("RGBA")
    source = source.crop(source.getbbox())
    label_height = 120
    model = ImageOps.contain(source, (width-80, height-label_height-50), Image.Resampling.LANCZOS)
    card.alpha_composite(model, ((width-model.width)//2, (height-label_height-model.height)//2))
    d = ImageDraw.Draw(card)
    text(d, (42, height-label_height+24), "Bat Cave", 42, NAVY)
    text(d, (42, height-42), "FROM THE BRICKBUILDER COMMUNITY", 19, (83, 98, 116), 600)
    return card.convert("RGB")


def compose(index, panorama, height, tablet=False):
    panel = panorama.crop((index*WIDTH, 0, (index+1)*WIDTH, height))
    d = ImageDraw.Draw(panel)
    text(d, (88, 91), "BRICK", 34, CORAL)
    text(d, (194, 91), "BUILDER AI", 34)
    text(d, (1044, 97), f"0{index+1} / 03", 25, MUTED, 600)
    y = 238 if tablet else 264
    size = 104 if index == 1 else 132
    if tablet:
        size = 98 if index == 1 else 116
    for i, line in enumerate(HEADLINES[index]):
        text(d, (85, y+i*(size+16)), line, size, CORAL if i else WHITE)
    desc_y = y + 2*(size+16) + 48
    for i, line in enumerate(DESCRIPTIONS[index]):
        text(d, (90, desc_y+i*52), line, 37 if tablet else 39, MUTED, 500)
    if index == 0:
        if tablet:
            hero(panel, (230, 650, 800, 610))
            app_card(panel, load_source("ipad-create.png"), (96, 1310), 1050)
            brick(panel, (920, 783), .57, (246, 211, 135), 18)
            brick(panel, (-90, 1000), .7)
        else:
            # A real exported model sits above a focused crop of the creation UI.
            hero(panel, (96, 835, 1050, 930))
            app_card(panel, load_source("iphone-create.png"), (121, 1900), 1000)
            pill(panel, (90, 795), "PHOTO OR TEXT  →  3D BRICKS", 25)
            brick(panel, (1000, 1010), .74, (246, 211, 135), 18)
            brick(panel, (-95, 1560), .8)
    elif index == 1:
        if tablet:
            app_card(panel, load_source("ipad-model.png"), (95, 740), 770)
            pill(panel, (875, 910), "REFINE WITH AI", 20)
            app_card(panel, load_source("ipad-refine.png"), (775, 1000), 370)
        else:
            app_card(panel, load_source("iphone-model.png"), (145, 925), 952)
            brick(panel, (1070, 809), .6, (246, 211, 135), 18)
    else:
        if tablet:
            app_card(panel, community_feature(950, 660), (146, 745), 950)
            app_card(panel, load_source("community-search.png"), (744, 1290), 400)
        else:
            app_card(panel, community_feature(1000, 1200), (121, 925), 1000)
            app_card(panel, load_source("community-search.png"), (145, 2230), 952)
            brick(panel, (-115, 785), .65, (246, 211, 135), -22)
    d = ImageDraw.Draw(panel)
    footer_y = height-113
    text(d, (90, footer_y), LABELS[index], 26, WHITE, 700)
    for n in range(3):
        x = 1038+n*36
        d.ellipse((x, footer_y+4, x+12, footer_y+16), fill=CORAL if n == index else (82, 96, 113))
    return panel.convert("RGB")


def render_export(spec):
    height = round(spec.height / spec.width * WIDTH)
    panorama = background(height)
    output = STORE / "screenshots" / spec.folder
    output.mkdir(parents=True, exist_ok=True)
    panels = []
    for index, name in enumerate(FILENAMES):
        panel = compose(index, panorama, height, spec.tablet)
        panel = panel.resize((spec.width, spec.height), Image.Resampling.LANCZOS)
        panel.save(output / name, optimize=True)
        panels.append(panel)
    # Only remove superseded screenshots in this dedicated generated directory.
    for path in output.glob("*.png"):
        if path.name not in FILENAMES:
            path.unlink()
    archive = STORE / f"brickbuilder-{spec.folder}-screenshots.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in FILENAMES:
            bundle.write(output / name, name)
    return panels


def contact_sheet(panels, path, thumbnail_width=414):
    height = round(panels[0].height / panels[0].width * thumbnail_width)
    sheet = Image.new("RGB", (thumbnail_width*3, height))
    for i, panel in enumerate(panels):
        sheet.paste(panel.resize((thumbnail_width, height), Image.Resampling.LANCZOS), (i*thumbnail_width, 0))
    sheet.save(path, quality=95)


def main():
    for spec in EXPORTS:
        panels = render_export(spec)
        contact_sheet(panels, STORE / f"preview-{spec.folder}.jpg")
    print("Exported exactly three RGB portrait PNGs per device set, ZIPs, and previews.")


if __name__ == "__main__":
    main()
