"""Direct, private voxel downloads with bounded isolated conversion workers."""
import asyncio
import logging
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from fastapi import HTTPException, UploadFile
from fastapi.responses import Response

from ..utils.auth import handle_auth_and_tracking

logger = logging.getLogger(__name__)
OUTPUT_FORMATS = frozenset({'vox', 'qb', 'binvox', 'xyzrgb'})
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
_WORKERS = threading.BoundedSemaphore(2)


def run_conversion(contents: bytes, input_format: str, output_format: str, resolution: int) -> bytes:
    if not _WORKERS.acquire(blocking=False):
        raise HTTPException(status_code=503, detail='Converters are busy. Please try again shortly.')
    try:
        with tempfile.TemporaryDirectory(prefix='mesh-voxels-') as directory:
            source = Path(directory) / f'input.{input_format}'
            output = Path(directory) / f'model.{output_format}'
            source.write_bytes(contents)
            result = subprocess.run(
                [sys.executable, '-m', 'src.utils.mesh_voxel_export', str(source), str(output), str(resolution)],
                cwd=Path(__file__).resolve().parents[2],
                env={**os.environ, 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90, check=False,
            )
            if result.returncode != 0 or not output.is_file():
                raise HTTPException(status_code=422, detail='Could not voxelize this model. Use a valid mesh with embedded resources, up to 250,000 faces and 256 instances.')
            return output.read_bytes()
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=422, detail='Conversion took too long. Try a simpler model or lower resolution.')
    finally:
        _WORKERS.release()


async def mesh_to_voxels(file: UploadFile, input_format: str, output_format: str,
                         resolution: int, auth_info: dict) -> Response:
    if input_format not in {'glb', 'obj'} or output_format not in OUTPUT_FORMATS:
        raise HTTPException(status_code=400, detail='Unsupported conversion format')
    if not 8 <= resolution <= 64:
        raise HTTPException(status_code=400, detail='Resolution must be between 8 and 64')
    if not (file.filename or '').lower().endswith(f'.{input_format}'):
        raise HTTPException(status_code=400, detail=f'Choose a .{input_format} file')
    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail='Model must be 50 MB or smaller')
    if not contents:
        raise HTTPException(status_code=400, detail='Uploaded file is empty')
    handle_auth_and_tracking(auth_info, '/meshToVoxels', {
        'input_format': input_format, 'output_format': output_format,
        'resolution': resolution, 'file_size': len(contents),
    }, required_credits=0)
    try:
        content = await asyncio.to_thread(run_conversion, contents, input_format, output_format, resolution)
    except HTTPException:
        raise
    except Exception:
        logger.exception('Voxel conversion failed')
        raise HTTPException(status_code=500, detail='Conversion failed. Please try again.')
    return Response(content=content, media_type='application/octet-stream', headers={
        'Content-Disposition': f'attachment; filename="model.{output_format}"',
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    })
