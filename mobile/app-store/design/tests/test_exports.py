"""Checks the actual upload artifacts, typography, and source boundaries."""

import importlib.util
from pathlib import Path
import sys
import unittest
import zipfile

from PIL import Image, ImageDraw


MODULE_PATH = Path(__file__).resolve().parents[1] / "render.py"
SPEC = importlib.util.spec_from_file_location("store_design", MODULE_PATH)
design = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = design
SPEC.loader.exec_module(design)


class ScreenshotExportTests(unittest.TestCase):
    def test_required_medium_display_has_an_accepted_upload_size(self):
        # Dimensions displayed by App Store Connect's required medium slot.
        accepted_portraits = {(1179, 2556), (1206, 2622)}
        required = [spec for spec in design.EXPORTS if spec.folder == "iphone-6.3"]
        self.assertEqual(len(required), 1)
        self.assertIn((required[0].width, required[0].height), accepted_portraits)

    def test_every_device_has_exactly_three_uploadable_portraits(self):
        for spec in design.EXPORTS:
            with self.subTest(device=spec.folder):
                folder = design.STORE / "screenshots" / spec.folder
                self.assertEqual(sorted(p.name for p in folder.glob("*.png")), list(design.FILENAMES))
                for name in design.FILENAMES:
                    with Image.open(folder / name) as image:
                        self.assertEqual(image.size, (spec.width, spec.height))
                        self.assertEqual(image.mode, "RGB")
                        self.assertEqual(image.format, "PNG")
                        self.assertGreater(image.height, image.width)
                        image.verify()

    def test_archives_match_the_upload_order_and_images(self):
        for spec in design.EXPORTS:
            with self.subTest(device=spec.folder):
                path = design.STORE / f"brickbuilder-{spec.folder}-screenshots.zip"
                with zipfile.ZipFile(path) as archive:
                    self.assertEqual(archive.namelist(), list(design.FILENAMES))
                    self.assertIsNone(archive.testzip())
                    for name in design.FILENAMES:
                        self.assertEqual(archive.read(name), (design.STORE / "screenshots" / spec.folder / name).read_bytes())

    def test_app_captures_match_the_expected_framing(self):
        for name, size in design.SOURCES.items():
            with self.subTest(source=name):
                self.assertEqual(design.load_source(name).size, size)

    def test_headlines_fit_within_the_safe_area(self):
        draw = ImageDraw.Draw(Image.new("RGB", (design.WIDTH, 2688)))
        for tablet in (False, True):
            for index, lines in enumerate(design.HEADLINES):
                size = (98 if index == 1 else 116) if tablet else (104 if index == 1 else 132)
                for line in lines:
                    self.assertLessEqual(draw.textlength(line, font=design.font(size)), design.WIDTH-170)

    def test_compatibility_captions_fit_within_the_safe_area(self):
        draw = ImageDraw.Draw(Image.new("RGB", (design.WIDTH, 2688)))
        for tablet in (False, True):
            for lines in design.DESCRIPTIONS:
                for line in lines:
                    self.assertLessEqual(
                        draw.textlength(line, font=design.font(37 if tablet else 39, 500)),
                        design.WIDTH - 180,
                    )

    def test_listing_text_respects_app_store_limits(self):
        metadata = design.STORE / "metadata/en-US"
        for name, limit in (("subtitle.txt", 30), ("promotional_text.txt", 170),
                            ("description.txt", 4000), ("release_notes.txt", 4000)):
            with self.subTest(field=name):
                value = (metadata / name).read_text().strip()
                self.assertTrue(value)
                self.assertLessEqual(len(value), limit)

    def test_exported_hero_has_detail_and_a_transparent_background(self):
        with Image.open(design.ROOT / "sources/knapp-center.png") as image:
            self.assertEqual(image.mode, "RGBA")
            self.assertGreaterEqual(min(image.size), 1024)
            self.assertIsNotNone(image.getbbox())
            self.assertEqual(image.getchannel("A").getextrema(), (0, 255))

    def test_community_feature_fits_both_portrait_layouts(self):
        for size in ((1000, 1200), (950, 660)):
            with self.subTest(size=size):
                card = design.community_feature(*size)
                self.assertEqual(card.size, size)
                self.assertEqual(card.mode, "RGB")
                self.assertGreater(len(card.getcolors(maxcolors=1_000_000)), 100)


if __name__ == "__main__":
    unittest.main()
