"""Export three connected App Store posters from original pets and real iOS captures.

Run with Python + Pillow + numpy. Wallpaper artwork was generated on fal.ai;
UI is never redrawn. Capture framing and provenance are in capture-manifest.json.
"""
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import zipfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent
STORE = ROOT.parent
REPO = ROOT.parents[2]
WIDTH = 1242
NAVY = (23, 32, 53)
WHITE = (255, 253, 248)
CORAL = (218, 70, 53)
MUTED = (90, 91, 98)


@dataclass(frozen=True)
class Export:
    folder: str
    width: int
    height: int
    tablet: bool = False


EXPORTS = (
    Export('iphone-6.3', 1206, 2622),
    Export('iphone-6.5', 1242, 2688),
    Export('iphone-6.9', 1320, 2868),
    Export('ipad-13', 2064, 2752, True),
)
FILENAMES = ('01-buddies.png', '02-create.png', '03-explore.png')
HEADLINES = (('Dream it.', 'Build with Pip.'), ('Make it', 'uniquely yours.'), ('Find your', 'next big idea.'))
DESCRIPTIONS = (
    ('Meet Pip, Nib and Clik.', 'Your little AI build buddies.'),
    ('Create LEGO-compatible 3D models.', 'Refine every detail with AI.'),
    ('Explore LEGO-compatible creations.', 'Get inspired by the community.'),
)
LABELS = ('01  MEET YOUR BUDDY', '02  CREATE WITH AI', '03  GET INSPIRED')
SOURCES = {
    'landing-ios.png': (1206, 2622),
    'model-ios.png': (1206, 2622),
    'edit-ios.png': (1206, 2622),
    'community-ios.png': (1206, 2622),
    'landing-ipad.png': (2064, 2752),
    'model-ipad.png': (2064, 2752),
    'edit-ipad.png': (2064, 2752),
    'community-ipad.png': (2064, 2752),
}
HEADLINE_SIZE = 128
CAPTION_SIZE = 45


@lru_cache(maxsize=64)
def font(size, weight=800):
    result = ImageFont.truetype(str(ROOT / 'fonts/Manrope.ttf'), size)
    result.set_variation_by_axes([weight])
    return result


def text(draw, xy, value, size, fill=NAVY, weight=800):
    draw.text(xy, value, font=font(size, weight), fill=fill, anchor='lt')


def load_source(name):
    image = Image.open(ROOT / 'sources' / name).convert('RGB')
    if image.size != SOURCES[name]:
        raise ValueError(f'Unexpected capture dimensions: {name}')
    return image


def background(height, theme='01-warm-studio.jpg'):
    # Render ONE panorama and split afterwards, preserving the ribbon at seams.
    return ImageOps.fit(Image.open(ROOT / 'wallpapers' / theme).convert('RGB'),
                        (WIDTH * 3, height), Image.Resampling.LANCZOS).convert('RGBA')


def rounded_paste(canvas, content, xy, radius=38):
    mask = Image.new('L', content.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, content.width-1, content.height-1), radius, fill=255)
    canvas.paste(content, xy, mask)


def app_card(canvas, source, xy, width, max_height=None, radius=44):
    height = round(source.height * width / source.width)
    if max_height and height > max_height:
        width = round(width * max_height / height)
        height = max_height
    shot = source.resize((width, height), Image.Resampling.LANCZOS)
    x, y = xy
    box = (x-10, y-10, x+width+10, y+height+10)
    shadow = Image.new('RGBA', canvas.size)
    ImageDraw.Draw(shadow).rounded_rectangle((box[0]-5, box[1]+24, box[2]+5, box[3]+28), radius+10, fill=(69, 35, 20, 60))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(28)))
    ImageDraw.Draw(canvas).rounded_rectangle(box, radius+10, fill='white', outline=(236, 229, 218), width=2)
    rounded_paste(canvas, shot, (x, y), radius)
    return x, y, width, height


def pet(canvas, pet_id, box):
    path = ROOT / 'sources/pip-original.png' if pet_id == 'pip' else REPO / f'frontend/public/pets/{pet_id}.webp'
    source = Image.open(path).convert('RGBA')
    if pet_id == 'pip':
        source = source.crop((195, 115, 1080, 1140))
    else:
        # Trim only the transparent border, preserving the original app artwork.
        bounds = source.getchannel('A').point(lambda a: 255 if a > 30 else 0).getbbox()
        source = source.crop(bounds)
    source = ImageOps.contain(source, (box[2], box[3]), Image.Resampling.LANCZOS)
    x = box[0] + (box[2]-source.width)//2
    y = box[1] + (box[3]-source.height)//2
    canvas.alpha_composite(source, (x,y))


def model_hero(canvas, box):
    source = Image.open(ROOT / 'sources/bat-cave.png').convert('RGBA')
    source = source.crop(source.getbbox())
    source = ImageOps.contain(source, (box[2], box[3]), Image.Resampling.LANCZOS)
    canvas.alpha_composite(source, (box[0]+(box[2]-source.width)//2, box[1]+(box[3]-source.height)//2))



def compose(index, panorama, height, tablet=False):
    panel = panorama.crop((index*WIDTH,0,(index+1)*WIDTH,height))
    draw = ImageDraw.Draw(panel)
    text(draw,(88,88),'BRICKBUILDER AI',31,weight=800)
    text(draw,(1058,92),f'0{index+1}',28,CORAL,700)
    title_y=210 if tablet else 236
    for line_n,line in enumerate(HEADLINES[index]):
        text(draw,(85,title_y+line_n*153),line,HEADLINE_SIZE,CORAL if line_n else NAVY)
    caption_y=title_y+352
    for line_n,line in enumerate(DESCRIPTIONS[index]):
        text(draw,(90,caption_y+line_n*60),line,CAPTION_SIZE,MUTED,500)
    if index==0:
        if tablet:
            pet(panel,'pip',(448,715,370,365))
            pet(panel,'nib',(135,845,270,230))
            pet(panel,'clik',(865,845,270,230))
            capture=load_source('landing-ipad.png').crop((50,250,2014,900))
            app_card(panel,capture,(96,1170),1050,radius=34)
        else:
            pet(panel,'pip',(312,815,620,745))
            pet(panel,'nib',(70,1220,320,390))
            pet(panel,'clik',(875,1220,300,390))
            capture=load_source('landing-ios.png').crop((25,800,1181,1390))
            app_card(panel,capture,(106,1800),1030,radius=34)
        draw=ImageDraw.Draw(panel)
        for name,cx in zip(('Nib','Pip','Clik'),(270,633,1000) if tablet else (230,622,1025)):
            draw.text((cx,1090 if tablet else 1630),name,font=font(30),fill=CORAL,anchor='mt')
    elif index==1:
        if tablet:
            source=load_source('model-ipad.png')
            app_card(panel,source.crop((75,370,1215,1775)),(70,740),575,radius=36)
            app_card(panel,load_source('edit-ipad.png').crop((1260,370,1990,1080)),(700,815),475,radius=34)
        else:
            app_card(panel,load_source('model-ios.png').crop((40,520,1166,1770)),(206,780),830)
            app_card(panel,load_source('edit-ios.png').crop((45,300,1161,1445)),(190,1655),862)
    else:
        if tablet:
            model_hero(panel,(86,700,1070,370))
            capture=load_source('community-ipad.png').crop((50,720,2014,1420))
            app_card(panel,capture,(96,1150),1050,radius=34)
        else:
            model_hero(panel,(50,840,1142,840))
            capture=load_source('community-ios.png').crop((25,1450,1181,2110))
            app_card(panel,capture,(106,1780),1030,radius=34)
            draw=ImageDraw.Draw(panel)
            text(draw,(100,1710),'BAT CAVE  ·  COMMUNITY BUILD',24,CORAL,800)
    draw=ImageDraw.Draw(panel)
    footer_y=height-101
    text(draw,(90,footer_y),LABELS[index],23,NAVY,800)
    for n in range(3):
        x=1040+n*36
        draw.ellipse((x,footer_y+3,x+12,footer_y+15),fill=CORAL if n==index else (192,175,157))
    return panel.convert('RGB')


def render_export(spec):
    height=round(spec.height/spec.width*WIDTH)
    panorama=background(height)
    output=STORE/'screenshots'/spec.folder
    output.mkdir(parents=True,exist_ok=True)
    panels=[]
    for index,name in enumerate(FILENAMES):
        panel=compose(index,panorama,height,spec.tablet).resize((spec.width,spec.height),Image.Resampling.LANCZOS)
        panel.save(output/name,optimize=True)
        panels.append(panel)
    for path in output.glob('*.png'):
        if path.name not in FILENAMES:
            path.unlink()
    with zipfile.ZipFile(STORE/f'brickbuilder-{spec.folder}-screenshots.zip','w',compression=zipfile.ZIP_DEFLATED) as archive:
        for name in FILENAMES:
            archive.write(output/name,name)
    return panels


def contact_sheet(panels,path,thumbnail_width=414):
    h=round(panels[0].height/panels[0].width*thumbnail_width)
    sheet=Image.new('RGB',(thumbnail_width*3,h))
    for index,panel in enumerate(panels):
        sheet.paste(panel.resize((thumbnail_width,h),Image.Resampling.LANCZOS),(index*thumbnail_width,0))
    sheet.save(path,quality=95)


def main():
    for spec in EXPORTS:
        contact_sheet(render_export(spec),STORE/f'preview-{spec.folder}.jpg')
    print('Exported three connected RGB portrait posters per device set.')


if __name__=='__main__':
    main()
