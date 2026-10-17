import importlib.util
from pathlib import Path
import unittest
import json
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('store_icon', ROOT / 'icon.py')
icon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icon)


class PipIconTests(unittest.TestCase):
    def test_export_is_opaque_and_white_at_every_edge(self):
        with Image.open(icon.OUTPUT) as image:
            self.assertEqual(image.size, (1024, 1024))
            self.assertEqual(image.mode, 'RGB')
            for box in ((0,0,1024,30), (0,994,1024,1024), (0,0,30,1024), (994,0,1024,1024)):
                self.assertEqual(image.crop(box).getextrema(), ((255,255),)*3)

    def test_native_configuration_uses_the_exported_icon(self):
        mobile = ROOT.parent.parent
        config = json.loads((mobile / 'app.json').read_text())['expo']
        self.assertEqual((mobile / config['icon']).resolve(), icon.OUTPUT.resolve())
        self.assertEqual(config['ios']['bundleIdentifier'], 'ai.brickbuilder.app')
        with Image.open(icon.OUTPUT) as image:
            self.assertNotEqual(image.getpixel((512,512)), (255,255,255))

    def test_small_home_screen_icon_keeps_visible_red_pet(self):
        image = icon.compose_icon(60)
        pixels = image.tobytes()
        colors = zip(pixels[0::3], pixels[1::3], pixels[2::3])
        red = sum(r > 100 and r > g * 1.8 and r > b * 1.8 for r,g,b in colors)
        self.assertGreater(red, 800)
        with self.assertRaises(ValueError):
            icon.compose_icon(16)
