"""Require the viewer's connected insertion sequence before Nova publishes."""
from __future__ import annotations

import asyncio
import json
import os
import pwd
import subprocess
import tempfile
import uuid
from pathlib import Path

PUBLICATION_VERSION = 1
MAX_MODEL_BYTES = 16 * 1024 * 1024
TOOLKIT_ROOT = Path('/opt/ldraw-nova')


def review_instructions(source: bytes, toolkit: Path, library: Path) -> dict:
    """Review a captured revision outside the agent's writable workspace."""
    if not source or len(source) > MAX_MODEL_BYTES:
        raise ValueError('Invalid instruction source size')
    account = pwd.getpwnam('nobody')
    with tempfile.TemporaryDirectory(prefix='nova-publication-instructions-') as directory:
        root = Path(directory)
        os.chown(root, account.pw_uid, account.pw_gid)
        model, output = root / 'model.mpd', root / 'instructions.ldr'
        model.write_bytes(source)
        try:
            subprocess.run([str(toolkit / '.venv/bin/python'), str(Path(__file__).with_name('flatten.py')),
                            str(model), str(output), str(library), '--instructions'],
                           cwd=toolkit, user=account.pw_uid, group=account.pw_gid, extra_groups=[],
                           env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'PYTHONPATH': str(toolkit),
                                'PYTHONDONTWRITEBYTECODE': '1', 'HOME': str(root)},
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=1800)
        except subprocess.CalledProcessError:
            if not output.with_suffix('.error').is_file():
                raise
            report = output.with_suffix('.review.json')
            if report.is_file() and report.stat().st_size <= 64 * 1024:
                return dict(json.loads(report.read_text()), passed=False)
            return {'passed': False, 'error': 'Complete connector and placement evidence is required.'}
        if not output.is_file() or not 0 < output.stat().st_size <= 32 * 1024 * 1024:
            raise ValueError('Instruction review did not produce a complete export')
        return {'passed': True}


def install_instruction_policy(tools, settings):
    if getattr(tools, '_brickbuilder_instruction_policy', False):
        return
    schema, publish = tools.TOOLS['publish_model']

    async def checked_publish(ctx, path: str, name: str | None = None):
        source = tools.resolve_path(ctx, path, write=True)
        if not source.is_file() or source.suffix.lower() not in {'.mpd', '.ldr'}:
            raise tools.ToolError('Publish a self-contained .mpd or .ldr from the output folder')
        if not 0 < source.stat().st_size <= MAX_MODEL_BYTES:
            raise tools.ToolError('Model exceeds the 16 MB instruction source limit')
        content = source.read_bytes()
        if len(content) > MAX_MODEL_BYTES:
            raise tools.ToolError('Model exceeds the 16 MB instruction source limit')
        ctx.emit('progress', {'summary': 'Checking connections and instruction placement order.'})
        try:
            # The owner toolkit is private and has writable discovery caches.
            # Independent review uses only the image's immutable toolkit.
            report = await asyncio.to_thread(review_instructions, content, TOOLKIT_ROOT, settings.LDRAW_DIR)
        except (ValueError, OSError, subprocess.SubprocessError):
            raise tools.ToolError('Instruction review could not finish. Publication is blocked; retry the check.') from None
        if report.get('passed') is not True:
            return tools.ToolResult(json.dumps({**report, 'reason': report.get('error'), 'error':
                'Publication blocked: repair disconnected or blocked pieces, then retry publish_model. '
                'Use the full connector report to verify every remaining piece. A warning about missing '
                'metadata is not evidence of a connection.'}))
        # The existing publisher reads the same captured bytes that were checked.
        # Preserve its palette, validation, render and BOM workflow.
        review = ctx.work_dir / ('instruction-publication-' + uuid.uuid4().hex)
        review.mkdir(mode=0o755)
        snapshot = review / 'model.mpd'
        snapshot.write_bytes(content)
        snapshot.chmod(0o444)
        return await publish(ctx, str(snapshot), name or source.stem)

    schema['function']['description'] += (
        ' Publication requires complete connector evidence and a connected instruction insertion sequence. '
        'Repair any reported remaining pieces and retry; disconnected warnings cannot be waived.')
    tools.TOOLS['publish_model'] = (schema, checked_publish)
    tools.t_publish_model = checked_publish
    tools._brickbuilder_instruction_policy = True
