"""Encode real iOS captures with readable captions and original fal.ai music."""
from pathlib import Path
import json
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
FONT = ROOT.parent / 'design/fonts/Manrope.ttf'
SPECS = {'iphone': (886, 1920), 'ipad': (1200, 1600)}
SCENES = (
    ('landing', 6, 'Meet your build buddy.', 'A little companion for your big ideas.'),
    ('buddies', 5, 'Find your kind of buddy.', 'Choose Pip, Nib or Clik.'),
    ('model', 4, 'Explore it in 3D.', 'See every little brick.'),
    ('edit', 4, 'Make it uniquely yours.', 'Refine LEGO-compatible models with AI.'),
    ('community', 5, 'Your next idea starts here.', 'Discover builds from the community.'),
)
CROPS = {
    'iphone': {'landing': (25,300,1156,1300), 'buddies': (45,560,1116,1400),
               'model': (40,520,1126,1250), 'edit': (45,300,1116,1145),
               'community': (25,680,1156,1430)},
    'ipad': {'landing': (220,250,1624,850), 'buddies': (320,730,1424,1170),
             'model': (75,370,1140,1405), 'edit': (1260,370,730,710),
             'community': (50,340,1964,1120)},
}



def font(size, weight=800):
    result=ImageFont.truetype(str(FONT),size)
    result.set_variation_by_axes([weight])
    return result


def caption(size, headline, detail):
    width,height=size
    scale=width/886
    image=Image.new('RGBA',size,(0,0,0,0))
    draw=ImageDraw.Draw(image)
    band=round((210 if height>1800 else 177)*scale)
    # Explanatory text is the only visual overlay on the recorded app.
    draw.rectangle((0,0,width,band),fill=(255,253,248,255))
    x=round(40*scale)
    draw.text((x,round(27*scale)),'BRICKBUILDER AI',font=font(round(22*scale)),fill='#DA4635',anchor='lt')
    draw.text((x,round(76*scale)),headline,font=font(round(45*scale)),fill='#172035',anchor='lt')
    draw.text((x,round(140*scale)),detail,font=font(round(28*scale),500),fill='#5A5B62',anchor='lt')
    return image


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)]))


def run(args):
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y',*map(str,args)],check=True)


def encode(device):
    width,height=SPECS[device]
    timeline=json.loads((ROOT/'timeline.json').read_text())
    with tempfile.TemporaryDirectory(prefix='brickbuilder-preview-') as tmp:
        tmp=Path(tmp); parts=[]
        for index,(scene,duration,headline,detail) in enumerate(SCENES):
            clip=ROOT/'sources'/f'{device}-{scene}.mp4'
            start=timeline[device][scene]['start']
            if float(probe(clip)['format'].get('duration',0)) < start+duration-.05:
                raise ValueError(f'{clip.name} is too short for the edit')
            cx,cy,cw,ch=CROPS[device][scene]
            app_height=height-(500 if device=='ipad' else 350)
            overlay=tmp/f'{index}.png';caption((width,height),headline,detail).save(overlay)
            output=tmp/f'{index}.mp4'
            run(['-ss',start,'-i',clip,'-loop','1','-i',overlay,'-filter_complex',
                 f'[0:v]crop={cw}:{ch}:{cx}:{cy},scale={width}:{app_height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0xfffdf8,setsar=1,fps=30[app];[app][1:v]overlay=0:0:shortest=1,format=yuv420p[v]',
                 '-map','[v]','-t',duration,'-an','-c:v','libx264','-preset','fast','-crf','17',output])
            parts.append(output)
        concat=tmp/'parts.txt';concat.write_text(''.join(f"file '{p}'\n" for p in parts))
        output=ROOT/f'brickbuilder-{device}-preview.mp4'
        run(['-f','concat','-safe','0','-i',concat,'-i',ROOT/'sources/build-buddy-music-fal.mp3',
             '-map','0:v:0','-map','1:a:0','-t','24','-c:v','libx264','-preset','slow',
             '-profile:v','high','-level:v','4.0','-b:v','10M','-maxrate','12M','-bufsize','24M',
             '-pix_fmt','yuv420p','-r','30','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',
             '-af','loudnorm=I=-18:TP=-1.5:LRA=9,afade=t=in:d=0.15,afade=t=out:st=22.8:d=1.2',
             '-c:a','aac','-b:a','256k','-ar','48000','-ac','2','-movflags','+faststart',output])
        print(f'Exported {output.name}: {width} × {height}, 24 seconds')


if __name__=='__main__':
    for device in SPECS:
        encode(device)
