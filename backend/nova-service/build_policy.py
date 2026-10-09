"""Require a fresh Nova build review at publication and final artifact export."""
from __future__ import annotations

import asyncio
import json
import os
import pwd
import subprocess
import tempfile
import uuid
from pathlib import Path

REVIEW_VERSION = 1
REVIEW_TIMEOUT = 1800
TOOLKIT_ROOT = Path('/opt/ldraw-nova')
MAX_MODEL_BYTES = 32 * 1024 * 1024
REVIEW_FAILURE = ('Nova build review failed. Repair disconnected parts and instruction steps '
                  'that rely on later connections, then resume the build.')


def review_source(source: bytes, library: Path):
    """Review an immutable byte snapshot outside the agent's Unix identity."""
    if not source or len(source) > MAX_MODEL_BYTES:
        raise ValueError('Invalid Nova model size')
    account = pwd.getpwnam('nobody')
    with tempfile.TemporaryDirectory(prefix='nova-build-review-') as directory:
        root = Path(directory)
        os.chown(root, account.pw_uid, account.pw_gid)
        model = root / 'model.mpd'
        model.write_bytes(source)
        subprocess.run([str(TOOLKIT_ROOT / '.venv/bin/python'), str(Path(__file__).with_name('build_review.py')),
                        str(model), str(library), str(root)], cwd=TOOLKIT_ROOT,
                       user=account.pw_uid, group=account.pw_gid, extra_groups=[],
                       env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'PYTHONPATH': str(TOOLKIT_ROOT),
                            'PYTHONDONTWRITEBYTECODE': '1', 'HOME': str(root)},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=REVIEW_TIMEOUT)
        def read(name, maximum):
            path = root / name
            if path.stat().st_size > maximum:
                raise ValueError('Nova review output exceeds its size limit')
            return path.read_bytes()
        report = json.loads(read('build-review.json', 8 * 1024 * 1024))
        if report.get('version') != REVIEW_VERSION or type(report.get('passed')) is not bool:
            raise ValueError('Nova build review is incomplete')
        artifacts = {name: read(name, MAX_MODEL_BYTES) for name in ('model.ldr', 'instructions.ldr')} if report['passed'] else {}
        return report, artifacts


def install_build_policy(tools, settings):
    if getattr(tools, '_brickbuilder_build_policy', False):
        return
    schema, publish = tools.TOOLS['publish_model']

    async def checked_publish(ctx, path: str, name: str | None = None):
        source = tools.resolve_path(ctx, path, write=True)
        if not source.is_file() or source.suffix.lower() not in {'.mpd', '.ldr'}:
            raise tools.ToolError('Publish a self-contained .mpd or .ldr from the output folder')
        if source.stat().st_size > MAX_MODEL_BYTES:
            raise tools.ToolError('Model exceeds the 32 MB publication limit')
        content = source.read_bytes()
        ctx.emit('progress', {'summary': 'Checking connections and every instruction step.'})
        try:
            report, _ = await asyncio.to_thread(review_source, content, settings.LDRAW_DIR)
        except (ValueError, OSError, subprocess.SubprocessError):
            raise tools.ToolError('Build review could not finish; publication is blocked. Retry after repairing the model.') from None
        # Preserve feedback for Nova to inspect and repair. Neither this copy nor
        # any other agent-writable report is trusted by the final export gate.
        review = ctx.work_dir / ('build-review-' + uuid.uuid4().hex)
        review.mkdir(mode=0o755)
        report_path = review / 'build-review.json'
        report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')
        if report['passed'] is not True:
            feedback = {'error': REVIEW_FAILURE, 'report': str(report_path),
                        'geometry': report.get('geometry'), 'diagnostics': report['diagnostics'][:10],
                        'instructions': {**report['instructions'],
                                         'failures': report['instructions'].get('failures', [])[:5]}}
            return tools.ToolResult(json.dumps(feedback))
        # Publish the exact bytes that passed, rather than rereading the agent's
        # editable file after the potentially long review.
        snapshot = review / 'model.mpd'
        snapshot.write_bytes(content)
        snapshot.chmod(0o444)
        return await publish(ctx, str(snapshot), name or source.stem)

    schema['function']['description'] += (
        ' BrickBuilder requires complete connectivity evidence and one connected assembly after every '
        'exported instruction step. Parts in the same step may connect together. Disconnected final '
        'groups, failed geometry checks, skipped contacts, and steps needing later connections block '
        'publication. Read the returned build-review report, repair the source, and retry. '
        'The flat instruction viewer requires subassemblies to be connected when shown; resequence '
        'or combine their construction steps where necessary.')
    tools.TOOLS['publish_model'] = (schema, checked_publish)
    tools.t_publish_model = checked_publish
    tools._brickbuilder_build_policy = True
