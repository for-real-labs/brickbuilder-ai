import asyncio
import base64
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from PIL import Image, ImageDraw
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.requests import photoScanner as api
from src.utils import photo_scanner as pipeline


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(api.router)
    api.scans.clear()
    app.dependency_overrides[api.get_optional_identity] = lambda: {'authenticated': True, 'auth_method': 'jwt', 'user_id': 'jake', 'user_email': 'jake@brickbuilder.ai'}
    with TestClient(app) as client:
        yield client
    api.scans.clear()


@pytest.mark.parametrize('identity,code', [({}, 401), ({'authenticated': True, 'auth_method': 'anonymous'}, 401),
    ({'authenticated': True, 'auth_method': 'api_key', 'user_id': 'developer', 'user_email': 'jake@brickbuilder.ai'}, 401),
    ({'authenticated': True, 'auth_method': 'jwt', 'user_id': 'other', 'user_email': 'other@example.com'}, 403)])
def test_all_endpoints_reject_other_identities(client, identity, code):
    client.app.dependency_overrides[api.get_optional_identity] = lambda: identity
    for method, url in [('GET', '/access'), ('POST', '/scans'), ('GET', '/scans/secret'), ('GET', '/scans/secret/assets/photo'), ('POST', '/scans/secret/cancel'), ('PATCH', '/scans/secret/regions/1')]:
        assert client.request(method, '/photo-scanner' + url, json={} if method == 'PATCH' else None).status_code == code


def make_scan(owner='jake'):
    scan = pipeline.Scan(owner, Image.new('RGB', (40, 40)))
    scan.assets['photo'] = pipeline.jpeg(scan.image)
    scan.regions = [{'id': '1', 'status': 'unmatched', 'candidates': [], 'match': None, 'excluded': False, 'reviewed': False}]
    api.scans[scan.id] = scan
    return scan


def test_assets_and_results_require_ownership_and_are_not_cacheable(client):
    scan = make_scan('different-id')
    assert client.get(f'/photo-scanner/scans/{scan.id}').status_code == 404
    scan.owner = 'jake'
    result = client.get(f'/photo-scanner/scans/{scan.id}/assets/photo')
    assert result.status_code == 200 and result.headers['cache-control'] == 'private, no-store'
    scan.created -= 3601
    assert client.get(f'/photo-scanner/scans/{scan.id}').status_code == 404


def test_review_manual_correction_exclusion_and_bad_candidate(client):
    scan = make_scan()
    scan.status = 'complete'
    url = f'/photo-scanner/scans/{scan.id}/regions/1'
    assert client.patch(url, json={'candidate_id': 'fake'}).status_code == 400
    result = client.patch(url, json={'part_id': '3001', 'name': 'Brick 2 x 4'}).json()
    assert result['regions'][0]['match']['score'] is None
    assert client.patch(url, json={'excluded': True}).json()['regions'][0]['excluded']
    assert client.patch(url, json={'unmatched': True}).json()['regions'][0]['match'] is None
    scan.regions[0]['status'] = 'pending'
    assert client.patch(url, json={}).status_code == 409


def test_scan_admission_limit_and_bad_image(client, monkeypatch):
    scan = make_scan()
    assert client.post('/photo-scanner/scans', files={'file': ('photo.jpg', b'bad')}).status_code == 429
    scan.status = 'complete'
    assert client.post('/photo-scanner/scans', files={'file': ('photo.jpg', b'bad')}).status_code == 400
    monkeypatch.setattr(api, 'MAX_BYTES', 2)
    assert client.post('/photo-scanner/scans', files={'file': ('photo.jpg', b'bad')}).status_code == 413


def test_tile_coverage_and_duplicate_detection():
    tiles = list(pipeline.tiles(4000, 3000))
    assert len(tiles) == 9 and tiles[0][:2] == (0, 0) and tiles[-1][2:] == (4000, 3000)
    assert tiles[1][0] < tiles[0][2]


def test_alternatives_are_not_additional_pieces_and_invalid_matches_are_dropped():
    items = [{'id': '3001', 'type': 'part', 'name': 'Brick', 'score': .9}, {'id': '3001', 'type': 'part', 'name': 'Brick', 'score': .8}, {'id': '3002', 'type': 'part', 'name': 'Brick 2', 'score': .7}, {'id': 'x', 'type': 'part', 'name': 'Invalid', 'score': float('nan')}]
    assert [item['id'] for item in pipeline.matches({'items': items})] == ['3001', '3002']


def test_partial_recognition_failure_and_rate_limit(monkeypatch):
    async def run():
        scan = make_scan()
        scanner = pipeline.Scanner()
        scan.assets['1'] = b'crop'
        calls = 0
        async def respond(request):
            nonlocal calls
            calls += 1
            if calls == 1: return httpx.Response(429, headers={'Retry-After': '0'})
            return httpx.Response(200, json={'items': [{'id': '3001', 'type': 'part', 'name': 'Brick', 'score': .9}]})
        monkeypatch.setattr(pipeline, 'retry_delay', lambda *_: 0)
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            await scanner.recognize(scan, http, scan.regions[0])
        assert scan.completed == 1 and scan.retries == 1 and scan.regions[0]['match']['id'] == '3001'
        region = {'id': '2', 'status': 'pending', 'match': None}
        scan.assets['2'] = b'crop'
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500))) as http:
            await scanner.recognize(scan, http, region)
        assert region['status'] == 'failed' and scan.completed == 2 and scan.regions[0]['match']
    asyncio.run(run())


def test_cancel_keeps_completed_results_and_cancels_provider():
    async def run():
        scan = make_scan()
        started = asyncio.Event()
        handle = SimpleNamespace(cancel=AsyncMock())
        async def segment(scan):
            scan.handle = handle
            started.set()
            await asyncio.Event().wait()
        scanner = pipeline.Scanner()
        scanner.segment = segment
        task = asyncio.create_task(scanner.run(scan))
        await started.wait(); task.cancel(); await task
        assert scan.status == 'cancelled' and len(scan.regions) == 1
        handle.cancel.assert_awaited_once()
    asyncio.run(run())


def test_sam_schema_mask_isolation_and_explicit_limit():
    async def run():
        mask = Image.new('RGB', (100, 100))
        ImageDraw.Draw(mask).rectangle((10, 20, 30, 50), fill='white')
        buf = io.BytesIO(); mask.save(buf, 'PNG')
        uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
        submit = AsyncMock(return_value=SimpleNamespace(get=AsyncMock(return_value={'masks': [{'url': uri}], 'scores': [.92]})))
        scanner = pipeline.Scanner(lambda: SimpleNamespace(submit=submit))
        scan = pipeline.Scan('jake', Image.new('RGB', (100, 100), 'red'))
        await scanner.segment(scan)
        assert submit.call_args.kwargs['arguments']['max_masks'] == 32
        assert submit.call_args.kwargs['arguments']['return_multiple_masks'] is True
        assert scan.regions[0]['box'] == [10, 20, 31, 51]
        assert scan.assets['1']
    asyncio.run(run())


def test_async_fal_client_uses_existing_server_key(monkeypatch):
    from src.utils import fal_provider_client
    monkeypatch.setenv('FAL_KEY', 'test-only')
    monkeypatch.setattr(fal_provider_client.fal_client, 'AsyncClient', lambda **kwargs: kwargs)
    assert fal_provider_client.get_async_fal_client() == {'key': 'test-only'}


def test_cancellation_during_segmentation_retains_previous_tile_and_cancels_queue():
    async def run():
        mask = Image.new('RGB', (646, 100)); ImageDraw.Draw(mask).rectangle((10, 20, 30, 50), fill='white')
        buf = io.BytesIO(); mask.save(buf, 'PNG')
        uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
        waiting = asyncio.Event()
        async def wait():
            waiting.set(); await asyncio.Event().wait()
        handle = SimpleNamespace(get=wait, cancel=AsyncMock())
        submit = AsyncMock(side_effect=[SimpleNamespace(get=AsyncMock(return_value={'masks': [{'url': uri}]})), handle])
        scan = pipeline.Scan('jake', Image.new('RGB', (1100, 100)))
        scanner = pipeline.Scanner(lambda: SimpleNamespace(submit=submit))
        task = asyncio.create_task(scanner.run(scan)); await waiting.wait(); task.cancel(); await task
        assert scan.status == 'cancelled' and len(scan.regions) == 1 and scan.assets['1']
        handle.cancel.assert_awaited_once()
    asyncio.run(run())


def test_identification_concurrency_is_bounded_and_cancel_stops_workers(monkeypatch):
    async def run():
        scanner = pipeline.Scanner()
        scan = pipeline.Scan('jake', Image.new('RGB', (10, 10)))
        scan.regions = [{'id': str(i), 'status': 'pending'} for i in range(8)]
        scanner.segment = AsyncMock()
        active = 0
        started = asyncio.Event()
        async def recognize(*args):
            nonlocal active
            active += 1
            if active == 2: started.set()
            try: await asyncio.Event().wait()
            finally: active -= 1
        scanner.recognize = recognize
        task = asyncio.create_task(scanner.run(scan)); await started.wait()
        assert active == 2
        task.cancel(); await task
        assert active == 0 and all(r['status'] == 'cancelled' for r in scan.regions)
    asyncio.run(run())


def test_retry_after_bounds_and_dates():
    assert pipeline.retry_delay('99999', 1) == 60
    assert pipeline.retry_delay('nonsense', 2) == 4
    assert pipeline.retry_delay('Wed, 21 Oct 2015 07:28:00 GMT', 1) == 1


def test_mask_dedup_keeps_touching_pieces_and_removes_partial_tile_observations():
    def png(image):
        b = io.BytesIO(); image.save(b, 'PNG'); return b.getvalue()
    full = Image.new('L', (100, 100), 255)
    partial = Image.new('L', (40, 100), 255)
    assert pipeline.same_mask(([0, 0, 100, 100], png(full)), ([60, 0, 100, 100], png(partial)))
    left = Image.new('L', (100, 100)); ImageDraw.Draw(left).rectangle((0, 0, 45, 99), fill=255)
    right = Image.new('L', (100, 100)); ImageDraw.Draw(right).rectangle((55, 0, 99, 99), fill=255)
    assert not pipeline.same_mask(([0, 0, 100, 100], png(left)), ([0, 0, 100, 100], png(right)))
