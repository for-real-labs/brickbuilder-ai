"""Private, bounded SAM 3 → Brickognize experiment. No public asset storage."""
import asyncio
import base64
import io
import math
import re
import time
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from uuid import uuid4

import httpx
from PIL import Image, ImageOps, ImageChops

from .fal_provider_client import get_async_fal_client

MAX_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 40_000_000
MAX_REGIONS = 288  # nine tiles × the provider's documented 32-mask maximum
TERMINAL = {'complete', 'cancelled', 'failed'}


def jpeg(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.convert('RGB').save(buffer, 'JPEG', quality=94)
    return buffer.getvalue()


def read_photo(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        if image.width * image.height > MAX_PIXELS:
            raise ValueError('Choose a photo smaller than 40 megapixels.')
        return ImageOps.exif_transpose(image).convert('RGB')
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError('Could not read this photo. Try JPEG, PNG or WebP.') from exc


def tiles(width: int, height: int):
    """At most nine overlapping tiles; original pixels are retained for crops."""
    columns, rows = min(3, math.ceil(width / 1000)), min(3, math.ceil(height / 1000))
    for y in range(rows):
        for x in range(columns):
            yield (max(0, int(x * width / columns) - 96), max(0, int(y * height / rows) - 96),
                   min(width, math.ceil((x + 1) * width / columns) + 96),
                   min(height, math.ceil((y + 1) * height / rows) + 96))


def same_mask(a, b) -> bool:
    """Compare visible foreground pixels, including partial observations at seams."""
    bounds_a, bytes_a = a[0], a[1]
    bounds_b, bytes_b = b[0], b[1]
    left, top = max(bounds_a[0], bounds_b[0]), max(bounds_a[1], bounds_b[1])
    right, bottom = min(bounds_a[2], bounds_b[2]), min(bounds_a[3], bounds_b[3])
    if right <= left or bottom <= top:
        return False
    with Image.open(io.BytesIO(bytes_a)) as mask_a, Image.open(io.BytesIO(bytes_b)) as mask_b:
        smaller = min(mask_a.histogram()[255], mask_b.histogram()[255])
        crop_a = mask_a.crop((left-bounds_a[0], top-bounds_a[1], right-bounds_a[0], bottom-bounds_a[1]))
        crop_b = mask_b.crop((left-bounds_b[0], top-bounds_b[1], right-bounds_b[0], bottom-bounds_b[1]))
        overlap = ImageChops.multiply(crop_a, crop_b).histogram()[255]
    return overlap / max(1, smaller) > 0.8


def matches(payload: dict) -> list[dict]:
    found = {}
    for item in payload.get('items', [])[:50]:
        if not isinstance(item, dict) or item.get('type') != 'part':
            continue
        part_id, name, score = item.get('id'), item.get('name'), item.get('score')
        if not isinstance(part_id, str) or not re.fullmatch(r'[\w.-]{1,100}', part_id, re.ASCII):
            continue
        if not isinstance(name, str) or not 0 < len(name) <= 500 or not isinstance(score, (int, float)) or not 0 <= score <= 1:
            continue
        # Catalog thumbnails only, never arbitrary URLs supplied by a client.
        url = item.get('img_url', '')
        thumbnail = url if isinstance(url, str) and url.startswith('https://storage.googleapis.com/brickognize-static/') else None
        if part_id not in found or score > found[part_id]['score']:
            found[part_id] = {'id': part_id, 'name': name, 'score': score, 'image_url': thumbnail}
    return sorted(found.values(), key=lambda item: item['score'], reverse=True)[:5]


def retry_delay(value: str | None, attempt: int) -> float:
    try:
        seconds = float(value) if value else 2 ** attempt
    except ValueError:
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (ValueError, TypeError, OverflowError):
            seconds = 2 ** attempt
    return max(1, min(60, seconds))


@dataclass
class Scan:
    owner: str
    image: Image.Image
    id: str = field(default_factory=lambda: str(uuid4()))
    created: float = field(default_factory=time.time)
    status: str = 'segmenting'
    regions: list = field(default_factory=list)
    assets: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)
    completed: int = 0
    tiles_done: int = 0
    tiles_total: int = 0
    duplicates: int = 0
    retries: int = 0
    elapsed: float = 0
    task: asyncio.Task | None = None
    handle: object = None

    def snapshot(self):
        return {'id': self.id, 'status': self.status, 'width': self.image.width, 'height': self.image.height,
                'regions': [] if self.status == 'segmenting' else self.regions, 'completed': self.completed, 'tiles_done': self.tiles_done,
                'tiles_total': self.tiles_total, 'duplicates_removed': self.duplicates, 'retries': self.retries,
                'warnings': self.warnings, 'elapsed_seconds': round(self.elapsed or time.time() - self.created, 1),
                'observed_cost_usd': None}


class Scanner:
    def __init__(self, client_factory=get_async_fal_client):
        self.client_factory = client_factory
        self.cooldown_until = 0.0

    async def segment(self, scan: Scan):
        client = self.client_factory()
        positions = list(tiles(*scan.image.size))
        scan.tiles_total = len(positions)
        candidates = []
        successful_tiles = 0
        for tile_index, box in enumerate(positions):
            tile = scan.image.crop(box)
            try:
                scan.handle = await client.submit('fal-ai/sam-3/image', arguments={
                    'image_url': 'data:image/jpeg;base64,' + base64.b64encode(jpeg(tile)).decode(),
                    'prompt': 'LEGO piece', 'return_multiple_masks': True, 'max_masks': 32,
                    'include_boxes': True, 'include_scores': True, 'apply_mask': False,
                    'sync_mode': True, 'output_format': 'png',
                })
                result = await asyncio.wait_for(scan.handle.get(), timeout=180)
                masks = result.get('masks', [])
                successful_tiles += 1
                if len(masks) >= 32:
                    scan.warnings.append(f'Tile {tile_index + 1} reached 32 masks; more pieces may be missing.')
                for index, entry in enumerate(masks[:32]):
                    # sync_mode avoids publishing or proxying unauthenticated asset URLs.
                    uri = entry.get('url', '')
                    if not uri.startswith('data:image/png;base64,') or len(uri) > 24 * 1024 * 1024:
                        raise ValueError('Unexpected mask format')
                    mask = read_photo(base64.b64decode(uri.split(',', 1)[1], validate=True)).convert('L')
                    mask = mask.resize(tile.size, Image.Resampling.NEAREST).point(lambda p: 255 if p > 127 else 0)
                    local = mask.getbbox()
                    if not local or (local[2]-local[0]) * (local[3]-local[1]) < 25:
                        continue
                    bounds = [local[0]+box[0], local[1]+box[1], local[2]+box[0], local[3]+box[1]]
                    scores = result.get('scores') or []
                    score = scores[index] if index < len(scores) else None
                    buffer = io.BytesIO()
                    mask.crop(local).save(buffer, 'PNG')
                    candidates.append((bounds, buffer.getvalue(), tile_index, score))
            except asyncio.CancelledError:
                if scan.handle:
                    try:
                        await asyncio.wait_for(scan.handle.cancel(), 5)
                    except Exception:
                        pass
                self.materialize(scan, candidates)
                raise
            except Exception as exc:
                if getattr(exc, 'status_code', None) in (401, 403):
                    scan.warnings.append('fal.ai rejected the configured credential. Check the server provider connection.')
                    raise
                scan.warnings.append(f'Tile {tile_index + 1} failed; other tile results are retained.')
                if scan.handle:
                    try:
                        await asyncio.wait_for(scan.handle.cancel(), 5)
                    except Exception:
                        pass
            finally:
                scan.handle = None
            scan.tiles_done += 1
            self.materialize(scan, candidates)
        if not successful_tiles:
            raise RuntimeError('All segmentation tiles failed')
        if not scan.regions:
            scan.warnings.append('No regions were found. Try a closer photo with pieces spread apart.')

    def materialize(self, scan: Scan, candidates: list):
        scan.regions = []
        scan.assets = {key: value for key, value in scan.assets.items() if key == 'photo'}
        scan.duplicates = 0
        # Larger observations first: overlapping tiles can cut a piece at an edge.
        candidates.sort(key=lambda c: (c[0][2]-c[0][0])*(c[0][3]-c[0][1]), reverse=True)
        accepted = []
        for bounds, mask_bytes, tile_index, score in candidates[:MAX_REGIONS]:
            candidate = (bounds, mask_bytes, tile_index)
            if any(tile_index != old[2] and same_mask(candidate, old) for old in accepted):
                scan.duplicates += 1
                continue
            accepted.append(candidate)
            region_id = str(len(scan.regions) + 1)
            crop = scan.image.crop(bounds)
            isolated = Image.new('RGB', crop.size, 'white')
            with Image.open(io.BytesIO(mask_bytes)) as mask:
                isolated.paste(crop, mask=mask)
            isolated = ImageOps.expand(isolated, border=max(8, round(max(crop.size)*0.08)), fill='white')
            isolated.thumbnail((1200, 1200))
            scan.assets[region_id] = jpeg(isolated)
            scan.regions.append({'id': region_id, 'box': bounds, 'detection_score': score,
                                 'status': 'pending', 'candidates': [], 'match': None,
                                 'excluded': False, 'reviewed': False})

    async def recognize(self, scan: Scan, client: httpx.AsyncClient, region: dict):
        try:
            for attempt in range(4):
                await asyncio.sleep(max(0, self.cooldown_until - time.monotonic()))
                response = await client.post('https://api.brickognize.com/predict/parts/',
                    files={'query_image': ('piece.jpg', scan.assets[region['id']], 'image/jpeg')})
                if response.status_code in (429, 503) and attempt < 3:
                    self.cooldown_until = max(self.cooldown_until, time.monotonic() + retry_delay(response.headers.get('Retry-After'), attempt))
                    scan.retries += 1
                    continue
                response.raise_for_status()
                region['candidates'] = matches(response.json())
                region['match'] = next(iter(region['candidates']), None)
                region['status'] = 'identified' if region['match'] else 'unmatched'
                break
        except asyncio.CancelledError:
            raise
        except Exception:
            region['status'] = 'failed'
        finally:
            if region['status'] != 'pending':
                scan.completed += 1

    async def run(self, scan: Scan):
        try:
            await self.segment(scan)
            scan.status = 'identifying'
            queue = iter(scan.regions)
            async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
                async def worker():
                    for region in queue:
                        await self.recognize(scan, client, region)
                # Structured cancellation also stops all in-flight crop requests.
                workers = [asyncio.create_task(worker()) for _ in range(2)]
                try:
                    await asyncio.gather(*workers)
                finally:
                    for task in workers:
                        task.cancel()
                    await asyncio.gather(*workers, return_exceptions=True)
            scan.status = 'complete'
        except asyncio.CancelledError:
            scan.status = 'cancelled'
            if scan.handle:
                try:
                    await asyncio.wait_for(scan.handle.cancel(), 5)
                except Exception:
                    pass
            for region in scan.regions:
                if region['status'] == 'pending':
                    region['status'] = 'cancelled'
        except Exception:
            scan.status = 'failed'
            scan.warnings.append('The scan stopped unexpectedly. Completed results are retained.')
        finally:
            scan.elapsed = time.time() - scan.created
            scan.handle = None
