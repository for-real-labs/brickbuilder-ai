"""Require the viewer's connected insertion sequence before Nova publishes."""
from __future__ import annotations

import asyncio
import json
import io
import csv
import zipfile
from collections import Counter
import os
import pwd
import subprocess
import tempfile
import uuid
from pathlib import Path

PUBLICATION_VERSION = 2
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
                            str(model), str(output), str(library), '--instructions', '--publication'],
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


def save_draft(ctx, content: bytes, report: dict, library: Path):
    """Preserve exactly the rejected revision and its expanded inventory."""
    account = pwd.getpwnam('nobody')
    with tempfile.TemporaryDirectory(prefix='nova-draft-') as directory:
        root = Path(directory)
        os.chown(root, account.pw_uid, account.pw_gid)
        model, flat = root / 'model.mpd', root / 'model.ldr'
        model.write_bytes(content)
        subprocess.run([str(TOOLKIT_ROOT / '.venv/bin/python'),
                        str(Path(__file__).with_name('flatten.py')), str(model), str(flat), str(library)],
                       cwd=TOOLKIT_ROOT, user=account.pw_uid, group=account.pw_gid, extra_groups=[],
                       env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'PYTHONPATH': str(TOOLKIT_ROOT),
                            'PYTHONDONTWRITEBYTECODE': '1', 'HOME': str(root)},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=120)
        if not 0 < flat.stat().st_size <= 32 * 1024 * 1024:
            raise ValueError('Draft display export exceeds size limit')
        display = flat.read_text()
    counts = Counter()
    for line in display.split('\n0 FILE ', 1)[0].splitlines():
        tokens = line.split()
        if len(tokens) == 15 and tokens[0] == '1':
            counts[tokens[14], tokens[1]] += 1
    bom = io.StringIO()
    writer = csv.writer(bom)
    writer.writerow(['Part', 'Color', 'Quantity'])
    writer.writerows((part, color, count) for (part, color), count in sorted(counts.items()))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('model.mpd', content)
        archive.writestr('model.ldr', display)
        archive.writestr('parts.csv', bom.getvalue())
        archive.writestr('verification.json', json.dumps(dict(report, passed=False)))
        archive.writestr('README.txt', 'Unverified draft. See verification.json for failed checks. '
                          'Connections, assembly instructions and mechanism motion are not verified. '
                          'Review and repair the model before building or ordering parts.\n')
    temporary = ctx.work_dir / ('.brickbuilder-draft-' + uuid.uuid4().hex)
    temporary.write_bytes(buffer.getvalue())
    temporary.replace(ctx.work_dir / '.brickbuilder-draft.zip')


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
        ctx.emit('progress', {'summary': 'Checking solid collisions, validation, and instruction placement order.'})
        try:
            # The owner toolkit is private and has writable discovery caches.
            # Independent review uses only the image's immutable toolkit.
            report = await asyncio.to_thread(review_instructions, content, TOOLKIT_ROOT, settings.LDRAW_DIR)
        except (ValueError, OSError, subprocess.SubprocessError):
            raise tools.ToolError('Instruction review could not finish. Publication is blocked; retry the check.') from None
        if report.get('passed') is not True:
            try:
                await asyncio.to_thread(save_draft, ctx, content, report, settings.LDRAW_DIR)
            except (ValueError, OSError, subprocess.SubprocessError):
                report = dict(report, draft_error='The draft archive could not be created.')
            return tools.ToolResult(json.dumps({**report, 'reason': report.get('error'), 'error':
                'Publication blocked: repair invalid, overlapping, disconnected or blocked pieces, then retry publish_model. '
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
        'Repair reported collisions and invalid or remaining pieces before retrying. '
        'Curved tiles and side studs need clearance: an attached part can still intersect solid plastic. '
        'Validation errors cannot be waived by visual review.')
    tools.TOOLS['publish_model'] = (schema, checked_publish)
    tools.t_publish_model = checked_publish
    tools._brickbuilder_instruction_policy = True
