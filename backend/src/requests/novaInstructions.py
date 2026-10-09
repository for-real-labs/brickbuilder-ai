"""Read Nova construction steps as physical placements for the existing viewer."""
from __future__ import annotations

import asyncio
from fastapi import HTTPException
from fastapi.responses import Response
from ..utils.generation_storage import generation_storage
from ..utils.nova_service import NovaService, read_export, NovaBuildReviewError, REVIEWED_INSTRUCTIONS_FILE


async def get_nova_instructions(generation_id: str) -> Response:
    if generation_storage is None:
        raise HTTPException(503, 'Generation storage is unavailable')
    row = await generation_storage.get_generation(generation_id)
    # Finished model geometry is public, as on /generation/{id}; private source,
    # reasoning, conversations and active jobs retain their owner checks.
    if not row or row.get('status') != 'completed' or row.get('endpoint') != 'novaToBricks':
        raise HTTPException(404, 'Nova instructions are unavailable')
    bucket = generation_storage.client.storage.from_('generation-output')
    try:
        data = await asyncio.to_thread(bucket.download, f'{generation_id}/{REVIEWED_INSTRUCTIONS_FILE}')
    except Exception:
        try:
            archive = await asyncio.to_thread(bucket.download, f'{generation_id}/nova-source.zip')
            original = await asyncio.to_thread(read_export, archive, {})
            async with NovaService() as runtime:
                content = await runtime.instructions(original.mpd)
            data = content.encode('utf-8')
            await asyncio.to_thread(bucket.upload, path=f'{generation_id}/{REVIEWED_INSTRUCTIONS_FILE}', file=data,
                                   file_options={'content-type': 'text/plain', 'upsert': 'true'})
        except NovaBuildReviewError as exc:
            raise HTTPException(409, str(exc)) from None
        except Exception as exc:
            raise HTTPException(503, 'Nova construction steps are unavailable. Check the private Nova runtime.') from exc
    return Response(data, media_type='text/plain', headers={'Cache-Control': 'public, max-age=3600',
                    'Content-Disposition': 'attachment; filename="nova-instructions.ldr"'})
