"""Validate the actual upload artifacts, capture provenance and readable copy."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
import zipfile
import numpy as np
from PIL import Image, ImageDraw

MODULE_PATH=Path(__file__).resolve().parents[1]/'render.py'
SPEC=importlib.util.spec_from_file_location('store_design',MODULE_PATH)
design=importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name]=design
SPEC.loader.exec_module(design)


class ScreenshotExportTests(unittest.TestCase):
    def test_required_phone_displays_have_accepted_portrait_dimensions(self):
        dimensions={s.folder:(s.width,s.height) for s in design.EXPORTS}
        self.assertEqual(dimensions['iphone-6.3'],(1206,2622))
        self.assertEqual(dimensions['iphone-6.9'],(1320,2868))
        self.assertEqual(dimensions['ipad-13'],(2064,2752))

    def test_every_device_has_exactly_three_valid_rgb_portrait_pngs(self):
        for spec in design.EXPORTS:
            folder=design.STORE/'screenshots'/spec.folder
            self.assertEqual(sorted(p.name for p in folder.glob('*.png')),list(design.FILENAMES))
            for name in design.FILENAMES:
                with self.subTest(device=spec.folder,file=name),Image.open(folder/name) as image:
                    self.assertEqual(image.size,(spec.width,spec.height))
                    self.assertEqual(image.mode,'RGB')
                    self.assertEqual(image.format,'PNG')
                    image.verify()

    def test_archives_contain_the_exact_uploads_in_display_order(self):
        for spec in design.EXPORTS:
            with zipfile.ZipFile(design.STORE/f'brickbuilder-{spec.folder}-screenshots.zip') as archive:
                self.assertEqual(archive.namelist(),list(design.FILENAMES))
                self.assertIsNone(archive.testzip())
                for name in design.FILENAMES:
                    self.assertEqual(archive.read(name),(design.STORE/'screenshots'/spec.folder/name).read_bytes())

    def test_source_captures_match_device_dimensions(self):
        for name,size in design.SOURCES.items():
            with self.subTest(capture=name):
                self.assertEqual(design.load_source(name).size,size)

    def test_headlines_and_captions_fit_the_safe_width(self):
        draw=ImageDraw.Draw(Image.new('RGB',(design.WIDTH,2688)))
        for blocks,size,weight in ((design.HEADLINES,design.HEADLINE_SIZE,800),(design.DESCRIPTIONS,design.CAPTION_SIZE,500)):
            for lines in blocks:
                for line in lines:
                    self.assertLessEqual(draw.textlength(line,font=design.font(size,weight)),design.WIDTH-180,line)

    def test_listing_fields_respect_apple_limits(self):
        root=design.STORE/'metadata/en-US'
        for name,limit in (('subtitle.txt',30),('promotional_text.txt',170),('description.txt',4000),('release_notes.txt',4000),('keywords.txt',100)):
            with self.subTest(field=name):
                value=(root/name).read_text().strip()
                self.assertTrue(value)
                self.assertLessEqual(len(value),limit)
        self.assertIn('LEGO-compatible',(root/'subtitle.txt').read_text())

    def test_wallpaper_seams_remain_continuous_in_final_exports(self):
        for spec in design.EXPORTS:
            folder=design.STORE/'screenshots'/spec.folder
            images=[np.asarray(Image.open(folder/n).convert('RGB')).astype(float) for n in design.FILENAMES]
            for left,right in zip(images,images[1:]):
                # Foreground never reaches the side edge: each join is the same panorama.
                self.assertLess(np.abs(left[:,-1,:]-right[:,0,:]).mean(),8,spec.folder)

    def test_capture_manifest_uses_the_real_production_app(self):
        manifest=json.loads((design.ROOT/'capture-manifest.json').read_text())
        self.assertEqual(manifest['app_version'],'1.0.2')
        self.assertEqual(manifest['model_url'],'https://brickbuilder.ai/generated-model?id=923b8062-6a0c-4313-9d4e-8ce157b7a379')
        self.assertEqual(set(manifest['screenshots']),set(design.SOURCES))
        self.assertEqual(manifest['capture_method'],'xcrun simctl screenshot and recordVideo')


if __name__=='__main__':
    unittest.main()
