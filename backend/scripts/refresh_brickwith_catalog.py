"""Refresh public storefront data, verifying completeness before atomic replacement.

Run: python backend/scripts/refresh_brickwith_catalog.py
No account, API key, cart, upload or purchase is involved. The storefront's
read endpoints use POST and are undocumented; schema drift fails closed.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.utils.parts_catalog import PartsCatalog, nonnegative_decimal, normalize_part_id

BASE = "https://server.brickwith.com/medusa_api/store_v2/part_main/"
PRODUCT = "https://www.brickwith.com/en/parts/Brick/3001?color_id=010"
PALETTE_HELP = "https://www.brickwith.com/en/about/help/article/how-do-i-reference-your-part-library-in-a-design-application-like-studio"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "src/data/brickwith_parts.csv"
HEADERS = {"Content-Type": "application/json", "Accept-Language": "en",
           "User-Agent": "BrickBuilderAI-Catalog/1.0 (public parts and prices)"}


class BrickwithStorefront:
    def read(self, url: str, body: dict | None = None) -> str:
        request = Request(url, data=json.dumps(body).encode() if body is not None else None, headers=HEADERS)
        # Bound downloads and retry only transient network failures.
        for attempt in range(3):
            try:
                with urlopen(request, timeout=60) as response:
                    data = response.read(16 * 1024 * 1024 + 1)
                if len(data) > 16 * 1024 * 1024:
                    raise ValueError("Brickwith response exceeds its size limit")
                return data.decode("utf-8")
            except OSError:
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError("Brickwith request failed")

    def query(self, endpoint: str, body: dict) -> dict:
        result = json.loads(self.read(BASE + endpoint, body))
        if result.get("code") != 1:
            raise ValueError("Brickwith rejected a catalog read; review its storefront schema")
        return result

    def products(self) -> list[dict]:
        total = int(self.query("find_list", {"sql_category": "getTotal"})["total"])
        rows = self.query("find_list", {"sql_category": "getList", "pageCurrent": 1,
                                       "pageSize": 10000})["rows"]
        if total <= 0 or len(rows) != total or len({row["spu_code"] for row in rows}) != total:
            raise ValueError("Incomplete Brickwith product list; existing catalog retained")
        details = []
        for start in range(0, len(rows), 50):
            codes = [row["spu_code"] for row in rows[start:start + 50]]
            batch = self.query("find_map_array", {"spu_code_array": codes, "part_sub_len": 1000})["rows"]
            if {row["spu_code"] for row in batch} != set(codes):
                raise ValueError("Incomplete Brickwith product details")
            details.extend(batch)
            print(f"Read {len(details)}/{total} products", flush=True)
            time.sleep(0.2)
        return details

    def colors(self) -> list[dict]:
        # The public product page embeds the same supplier color references
        # used by the storefront. Read JSON data, never execute page scripts.
        html = self.read(PRODUCT)
        for chunk in flight_chunks(html):
            match = re.search(r'"colors":(\[)', chunk)
            if match:
                colors, _ = json.JSONDecoder().raw_decode(chunk[match.start(1):])
                if colors and all("ldraw_color_id" in row for row in colors):
                    return colors
        raise ValueError("Brickwith color references are unavailable")

    def palette_reference(self) -> dict:
        html = self.read(PALETTE_HELP)
        urls = set(re.findall(r"https://file\.brickwith\.com/open/brickwith-parts-[0-9]+", html))
        if len(urls) != 1:
            raise ValueError("Brickwith palette download could not be identified")
        url = urls.pop()
        palette = self.read(url)
        return {"url": url, "sha256": hashlib.sha256(palette.encode()).hexdigest(),
                "placements": sum(line.startswith("0 ") for line in palette.splitlines())}


def flight_chunks(html: str):
    for raw in re.findall(r"self\.__next_f\.push\((.*?)\)</script>", html):
        value = json.loads(raw)
        if len(value) > 1 and isinstance(value[1], str):
            yield value[1]


def catalog_csv(products: list[dict], colors: list[dict]) -> tuple[str, dict]:
    color_map = {row["color_id"]: row["ldraw_color_id"] for row in colors}
    if len(color_map) != len(colors):
        raise ValueError("Duplicate Brickwith color references")
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["part_id", "color_id", "name", "sku", "unit_price", "weight_kg", "supplier_color_id"])
    variants, unmapped = 0, 0
    seen_skus = set()
    for product in sorted(products, key=lambda row: row["spu_code"]):
        metadata = product["metadata"]
        rows = metadata["showVariants"]
        if len(rows) != int(metadata["variantCount"]):
            raise ValueError("Brickwith truncated a product's color variants")
        part_id = normalize_part_id(product["main_ldraw_id"]) if product.get("main_ldraw_id") else ""
        for row in sorted(rows, key=lambda row: row["color_id"]):
            sku = row["sku_code"]
            if sku in seen_skus or row["spu_code"] != product["spu_code"]:
                raise ValueError("Duplicate or mismatched Brickwith variant")
            seen_skus.add(sku)
            raw_color = color_map.get(row["color_id"])
            if raw_color is None and part_id:
                raise ValueError("Unknown supplier color; refresh the color reference parser")
            color = int(raw_color) if raw_color and raw_color.isdigit() else ""
            price = nonnegative_decimal(row["price"])
            if price <= 0:
                raise ValueError("Brickwith variant has no purchasable price")
            weight = nonnegative_decimal(row["weight"]) / 1000  # storefront grams -> kg
            variants += 1
            unmapped += not part_id or color == ""
            writer.writerow([part_id, color, product["part_name"], sku, str(price), str(weight), row["color_id"]])
    content = output.getvalue()
    catalog = PartsCatalog.from_csv(content, name="Brickwith")
    return content, {"products": len(products), "variants": variants,
                     "mapped_part_color_pairs": len(catalog.parts), "unmapped_variants": unmapped}


def refresh(output: Path, source: BrickwithStorefront | None = None) -> dict:
    source = source or BrickwithStorefront()
    palette = source.palette_reference()
    content, counts = catalog_csv(source.products(), source.colors())
    metadata = {"supplier": "Brickwith", "currency": "USD", "fetched_at": datetime.now(timezone.utc).isoformat(),
                "list_endpoint": BASE + "find_list", "detail_endpoint": BASE + "find_map_array",
                "color_reference": PRODUCT, "palette": palette, **counts,
                "sha256": hashlib.sha256(content.encode()).hexdigest()}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".csv.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(output)
    output.with_suffix(".metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    print(json.dumps(refresh(parser.parse_args().output), indent=2))
