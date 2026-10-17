"""Validate the upload artifacts against Google Play's required dimensions."""

from pathlib import Path
import sys
import unittest

from PIL import Image


DESIGN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESIGN))
import render_google_play as play


class GooglePlayExportTests(unittest.TestCase):
    def test_phone_artwork_is_opaque_and_has_an_accepted_aspect_ratio(self):
        phones = play.OUTPUT / "graphics/phone"
        self.assertEqual(sorted(p.name for p in phones.glob("*.png")), list(play.design.FILENAMES))
        for path in phones.glob("*.png"):
            with self.subTest(path=path.name), Image.open(path) as image:
                self.assertEqual(image.size, (1080, 1920))
                self.assertEqual(image.mode, "RGB")
                self.assertLessEqual(max(image.size), min(image.size) * 2)
                image.verify()

    def test_feature_graphic_and_icon_match_required_formats(self):
        for name, size, mode in (("feature-graphic.png", (1024, 500), "RGB"),
                                 ("icon.png", (512, 512), "RGBA")):
            with self.subTest(asset=name), Image.open(play.OUTPUT / "graphics" / name) as image:
                self.assertEqual(image.size, size)
                self.assertEqual(image.mode, mode)
                self.assertLess((play.OUTPUT / "graphics" / name).stat().st_size, 1024 * 1024)

    def test_description_reuses_the_ios_copy_and_text_fits_play_limits(self):
        metadata = play.OUTPUT / "metadata/en-US"
        self.assertEqual((metadata / "full-description.txt").read_bytes(),
                         (play.design.STORE / "metadata/en-US/description.txt").read_bytes())
        for name, limit in (("title.txt", 30), ("short-description.txt", 80),
                            ("full-description.txt", 4000), ("release-notes.txt", 500)):
            with self.subTest(field=name):
                value = (metadata / name).read_text().strip()
                self.assertTrue(value)
                self.assertLessEqual(len(value), limit)

    def test_portrait_adaptation_keeps_all_source_pixels_without_distortion(self):
        source = Image.new("RGB", (1242, 2688), "white")
        adapted = play.phone_screenshot(source)
        self.assertEqual(adapted.size, (1080, 1920))
        self.assertEqual(adapted.getpixel((540, 0)), (255, 255, 255))
        self.assertEqual(adapted.getpixel((540, 1919)), (255, 255, 255))
        self.assertEqual(adapted.getpixel((0, 960)), play.design.NAVY)


if __name__ == "__main__":
    unittest.main()
