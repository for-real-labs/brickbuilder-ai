"""Compose the original Pip artwork on an opaque, white App Store icon."""
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'sources/pip-original.png'
OUTPUT = ROOT.parents[1] / 'assets/icon.png'


def compose_icon(size=1024):
    if size < 32:
        raise ValueError('Icon size must be at least 32 pixels')
    original = Image.open(SOURCE).convert('RGBA')
    # Framing is the same original pet used in the app, with no redrawing.
    pet = original.crop((195, 115, 1080, 1140))
    pet = ImageOps.contain(pet, (round(size * .78), round(size * .82)), Image.Resampling.LANCZOS)
    icon = Image.new('RGB', (size, size), 'white')
    icon.paste(pet, ((size-pet.width)//2, (size-pet.height)//2), pet.getchannel('A'))
    return icon


if __name__ == '__main__':
    compose_icon().save(OUTPUT, optimize=True)
    print(f'Exported {OUTPUT.name}: 1024 × 1024 RGB, white background')
