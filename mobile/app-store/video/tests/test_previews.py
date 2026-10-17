import importlib.util
from pathlib import Path
import unittest
from PIL import ImageDraw,Image

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('video_encode',ROOT/'encode.py')
video=importlib.util.module_from_spec(spec);spec.loader.exec_module(video)


class AppPreviewTests(unittest.TestCase):
    def test_captions_fit_both_preview_sizes(self):
        for width,height in video.SPECS.values():
            scale=width/886
            draw=ImageDraw.Draw(Image.new('RGB',(width,height)))
            for _,_,headline,detail in video.SCENES:
                for value,size,weight in ((headline,45,800),(detail,28,500)):
                    self.assertLessEqual(draw.textlength(value,font=video.font(round(size*scale),weight)),width-80*scale)
                overlay=video.caption((width,height),headline,detail)
                self.assertEqual(overlay.getpixel((width//2,height-1))[3],0)

    def test_outputs_satisfy_apple_video_requirements(self):
        for device,size in video.SPECS.items():
            file=ROOT/f'brickbuilder-{device}-preview.mp4'
            with self.subTest(device=device):
                data=video.probe(file)
                self.assertLess(file.stat().st_size,500*1024*1024)
                self.assertAlmostEqual(float(data['format']['duration']),24,delta=.1)
                picture=next(s for s in data['streams'] if s['codec_type']=='video')
                sound=next(s for s in data['streams'] if s['codec_type']=='audio')
                self.assertEqual((picture['width'],picture['height']),size)
                self.assertEqual(picture['codec_name'],'h264')
                self.assertEqual(picture['profile'],'High')
                self.assertEqual(picture['level'],40)
                self.assertEqual(picture['pix_fmt'],'yuv420p')
                self.assertEqual(picture['field_order'],'progressive')
                n,d=map(int,picture['avg_frame_rate'].split('/'))
                self.assertLessEqual(n/d,30)
                self.assertEqual(sound['codec_name'],'aac')
                self.assertEqual(sound['channels'],2)
                self.assertIn(sound['sample_rate'],('44100','48000'))

    def test_the_entire_edit_is_real_device_capture(self):
        self.assertEqual(sum(s[1] for s in video.SCENES),24)
        for device in video.SPECS:
            for name,duration,_,_ in video.SCENES:
                capture=ROOT/'sources'/f'{device}-{name}.mp4'
                data=video.probe(capture)
                self.assertGreaterEqual(float(data['format']['duration']),duration-.05)


if __name__=='__main__':
    unittest.main()
