"""Render a branded, crawler-friendly PNG for a completed model."""
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError

ASSETS = Path(__file__).resolve().parents[1] / "assets"
WIDTH, HEIGHT = 1200, 630


def _fitted_name(draw: ImageDraw.ImageDraw, name: str, max_width: int) -> tuple[str, ImageFont.FreeTypeFont]:
    label = " ".join(name.split())[:90] or "My model"
    for size in range(53, 30, -2):
        font = ImageFont.truetype(ASSETS / "Manrope.ttf", size)
        if draw.textlength(label, font=font) <= max_width:
            return label, font
    font = ImageFont.truetype(ASSETS / "Manrope.ttf", 31)
    while label and draw.textlength(label + "…", font=font) > max_width:
        label = label[:-1]
    return label.rstrip() + "…", font


def render_share_card(name: str, preview_png: bytes) -> bytes:
    """Compose a 1200×630 card while keeping the model image prominent."""
    try:
        with Image.open(BytesIO(preview_png)) as source:
            if source.width > 4096 or source.height > 4096:
                raise ValueError("Preview image is too large")
            model = source.convert("RGBA")
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("Invalid preview image") from error

    canvas = Image.new("RGBA", (WIDTH, HEIGHT), "#f7f6f2")
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((26, 26, 1174, 604), radius=40, fill="#fffefa", outline="#e9e4dc", width=2)
    draw.rounded_rectangle((686, 54, 1145, 576), radius=36, fill="#f3ddd6")
    for x, y, radius in ((731, 100, 25), (1084, 112, 15), (715, 530, 19), (1111, 532, 25)):
        draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill="#f9eae5", outline="#e9c5ba", width=3)
    draw.rounded_rectangle((728, 89, 1104, 540), radius=30, fill="#fffaf5")

    bounds = model.getbbox()
    if bounds:
        model = model.crop(bounds)
    model = ImageOps.contain(model, (356, 421), Image.Resampling.LANCZOS)
    canvas.alpha_composite(model, (728 + (376-model.width)//2, 89 + (451-model.height)//2))

    wordmark = Image.open(ASSETS / "brand-wordmark.png").convert("RGBA")
    wordmark = ImageOps.contain(wordmark, (370, 182), Image.Resampling.LANCZOS)
    canvas.alpha_composite(wordmark, (86, 71))
    draw = ImageDraw.Draw(canvas)
    regular = ImageFont.truetype(ASSETS / "Manrope.ttf", 47)
    bold = ImageFont.truetype(ASSETS / "Manrope.ttf", 53)
    draw.text((90, 289), "Check out my", font=regular, fill="#17243b")
    draw.text((90, 345), "model", font=bold, fill="#d9322a", stroke_width=1)
    label, name_font = _fitted_name(draw, name, 535)
    draw.text((90, 428), label, font=name_font, fill="#17243b")
    draw.rounded_rectangle((89, 542, 320, 580), radius=19, fill="#dc3028")
    footer = ImageFont.truetype(ASSETS / "Manrope.ttf", 20)
    draw.text((113, 546), "brickbuilder.ai", font=footer, fill="white")
    pip = Image.open(ASSETS / "pip.webp").convert("RGBA")
    pip = ImageOps.contain(pip, (113, 113), Image.Resampling.LANCZOS)
    canvas.alpha_composite(pip, (546, 485))

    output = BytesIO()
    canvas.convert("RGB").save(output, format="PNG", optimize=True)
    return output.getvalue()
