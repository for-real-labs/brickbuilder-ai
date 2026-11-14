"""Account-restricted prototype endpoints; all images require bearer authentication."""
import asyncio
import time

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from ..utils.auth import get_optional_identity
from ..utils.photo_scanner import MAX_BYTES, Scan, Scanner, TERMINAL, jpeg, read_photo

router = APIRouter(prefix='/photo-scanner', tags=['Private photo scanner'])
scans: dict[str, Scan] = {}
scanner = Scanner()


async def require_scanner(auth: dict = Depends(get_optional_identity)) -> str:
    if auth.get('auth_method') != 'jwt' or not auth.get('authenticated') or not auth.get('user_id'):
        raise HTTPException(401, 'Sign in to use this private prototype.')
    if (auth.get('user_email') or '').lower() != 'jake@brickbuilder.ai':
        raise HTTPException(403, 'This prototype is private.')
    return auth['user_id']


def owned(scan_id: str, owner: str) -> Scan:
    scan = scans.get(scan_id)
    if not scan or scan.owner != owner or time.time() - scan.created > 3600:
        raise HTTPException(404, 'Scan expired or unavailable. Start a new scan.')
    return scan


def cleanup():
    for scan_id, scan in list(scans.items()):
        if time.time() - scan.created > 3600:
            if scan.task and not scan.task.done():
                scan.task.cancel()
            del scans[scan_id]


@router.get('/access')
async def access(response: Response, owner: str = Depends(require_scanner)):
    response.headers['Cache-Control'] = 'private, no-store'
    return {'allowed': True}


@router.post('/scans', status_code=202)
async def start_scan(response: Response, file: UploadFile = File(...), owner: str = Depends(require_scanner)):
    cleanup()
    if any(scan.status not in TERMINAL for scan in scans.values()):
        raise HTTPException(429, 'A scan is already running. Cancel it or wait for it to finish.')
    try:
        data = await file.read(MAX_BYTES + 1)
    finally:
        await file.close()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, 'Choose a photo smaller than 16 MB.')
    try:
        image = read_photo(data)
        # Fail before scheduling or uploading if the existing credential is absent.
        scanner.client_factory()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    # No await between admission and insertion, so concurrent uploads cannot both start.
    if any(scan.status not in TERMINAL for scan in scans.values()):
        raise HTTPException(429, 'A scan is already running.')
    while len(scans) >= 2:
        del scans[min(scans, key=lambda key: scans[key].created)]
    scan = Scan(owner=owner, image=image)
    scan.assets['photo'] = jpeg(image)
    scans[scan.id] = scan
    scan.task = asyncio.create_task(scanner.run(scan))
    response.headers['Cache-Control'] = 'private, no-store'
    return scan.snapshot()


@router.get('/scans/{scan_id}')
async def get_scan(scan_id: str, response: Response, owner: str = Depends(require_scanner)):
    response.headers['Cache-Control'] = 'private, no-store'
    return owned(scan_id, owner).snapshot()


@router.get('/scans/{scan_id}/assets/{asset_id}')
async def asset(scan_id: str, asset_id: str, owner: str = Depends(require_scanner)):
    data = owned(scan_id, owner).assets.get(asset_id)
    if data is None:
        raise HTTPException(404, 'Image unavailable.')
    return Response(data, media_type='image/jpeg', headers={'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})


@router.post('/scans/{scan_id}/cancel')
async def cancel(scan_id: str, response: Response, owner: str = Depends(require_scanner)):
    scan = owned(scan_id, owner)
    if scan.task and not scan.task.done():
        scan.task.cancel()
        await asyncio.gather(scan.task, return_exceptions=True)
        scan.status = 'cancelled'
    response.headers['Cache-Control'] = 'private, no-store'
    return scan.snapshot()


class Review(BaseModel):
    excluded: bool = False
    candidate_id: str | None = Field(default=None, max_length=100)
    part_id: str | None = Field(default=None, pattern=r'^[A-Za-z0-9._-]{1,100}$')
    name: str | None = Field(default=None, min_length=1, max_length=200)
    unmatched: bool = False


@router.patch('/scans/{scan_id}/regions/{region_id}')
async def review(scan_id: str, region_id: str, body: Review, response: Response, owner: str = Depends(require_scanner)):
    scan = owned(scan_id, owner)
    region = next((r for r in scan.regions if r['id'] == region_id), None)
    if not region:
        raise HTTPException(404, 'Region unavailable.')
    if region['status'] == 'pending':
        raise HTTPException(409, 'Wait for this region to finish or cancel the scan.')
    match = region['match']
    if body.candidate_id:
        match = next((c for c in region['candidates'] if c['id'] == body.candidate_id), None)
        if match is None:
            raise HTTPException(400, 'Choose one of this region’s candidates.')
    elif body.part_id:
        match = {'id': body.part_id, 'name': body.name or body.part_id, 'score': None, 'image_url': None}
    elif body.unmatched:
        match = None
    region.update(match=match, excluded=body.excluded, reviewed=True,
                  status='identified' if match else 'unmatched')
    response.headers['Cache-Control'] = 'private, no-store'
    return scan.snapshot()
