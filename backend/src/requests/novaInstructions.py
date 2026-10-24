"""Read Nova construction steps as physical placements for the existing viewer."""
from __future__ import annotations

import asyncio
from fastapi import HTTPException
from fastapi.responses import Response
from ..utils.generation_storage import generation_storage
from ..utils.nova_service import NovaService, read_export, INSTRUCTIONS_FILE, NovaInstructionPlanError


_instruction_exports: dict[str, asyncio.Task[bytes]] = {}
_instruction_load_slots = asyncio.Semaphore(2)


async def get_nova_instructions(generation_id: str) -> Response:
    if generation_storage is None:
        raise HTTPException(503, 'Generation storage is unavailable')
    row = await generation_storage.get_generation(generation_id)
    if not row or row.get('status') != 'completed' or row.get('endpoint') != 'novaToBricks':
        raise HTTPException(404, 'Nova instructions are unavailable')
    if row.get('nova_build_mode') == 'preview':
        raise HTTPException(409, 'Instructions are unavailable for this earlier unchecked preview. Create a new build.')
    task = _instruction_exports.get(generation_id)
    if task is None:
        task = asyncio.create_task(_load_instructions(generation_id))
        _instruction_exports[generation_id] = task
        task.add_done_callback(lambda completed: _instruction_exports.pop(generation_id, None))
    # A visitor leaving must not cancel the shared export for other visitors.
    data = await asyncio.shield(task)
    return Response(data, media_type='text/plain', headers={'Cache-Control': 'private, no-store',
                    'Content-Disposition': 'attachment; filename="nova-instructions.ldr"'})


async def _load_instructions(generation_id: str) -> bytes:
    bucket = generation_storage.client.storage.from_('generation-output')
    try:
        data = await asyncio.to_thread(bucket.download, f'{generation_id}/{INSTRUCTIONS_FILE}')
    except Exception:
        try:
            async with _instruction_load_slots:
                archive = await asyncio.to_thread(bucket.download, f'{generation_id}/nova-source.zip')
                original = await asyncio.to_thread(read_export, archive, {})
                async with NovaService() as runtime:
                    content = await runtime.instructions(original.mpd)
                data = content.encode('utf-8')
                await asyncio.to_thread(bucket.upload, path=f'{generation_id}/{INSTRUCTIONS_FILE}', file=data,
                                       file_options={'content-type': 'text/plain', 'upsert': 'true'})
        except NovaInstructionPlanError as exc:
            raise HTTPException(409, str(exc)) from None
        except Exception as exc:
            raise HTTPException(503, 'Nova construction steps are unavailable. Check the private Nova runtime.') from exc
    return data
