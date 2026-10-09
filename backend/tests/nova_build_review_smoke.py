"""Run with the toolkit Python in a prepared Nova image; no providers/network."""
import json
import logging
logging.disable(logging.WARNING)
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, '/review')
from build_review import review_model

root = Path(tempfile.mkdtemp(prefix='nova-review-smoke-'))
library = Path('/opt/ldraw/ldraw')
source = root / 'model.mpd'


def part(x, y, reference='3001.dat'):
    return f'1 4 {x} {y} 0 1 0 0 0 1 0 0 0 1 {reference}\n'


def check(label, text, passed, failed_steps=None):
    source.write_text(text, encoding='utf-8')
    report = review_model(source, library, root)
    assert report['passed'] is passed, (label, report)
    if failed_steps is not None:
        assert [f['step'] for f in report['instructions']['failures']] == failed_steps, report
    print(label + ': PASS', flush=True)
    return report


header = '0 FILE main.ldr\n'
check('Connected stack', header + part(0, 0) + '0 STEP\n' + part(0, -24), True, [])
check('Disconnected final model', header + part(0, 0) + '0 STEP\n' + part(400, 0), False, [2])
check('Later bridge fails earlier instruction step', header + part(0, 0) + '0 STEP\n' + part(80, 0)
      + '0 STEP\n' + part(40, -24), False, [2])
check('Same-step bridge passes', header + part(0, 0) + '0 STEP\n' + part(80, 0) + part(40, -24), True, [])
check('Duplicate placements rejected', header + part(0, 0) + part(0, 0), False)
check('Missing library part rejected', header + part(0, 0, 'does-not-exist.dat'), False)
check('Nested authored steps retain transforms and colors',
      header + part(0, 0, 'child.ldr') + '0 FILE child.ldr\n' + part(0, 0) + '0 STEP\n' + part(0, -24), True, [])
assert (root / 'instructions.ldr').read_text().count('0 STEP') == 2
reported = Path('/reported.ldr')
if reported.exists():
    report = check('Reported guitar rejected', '0 FILE model.ldr\n' + reported.read_text(), False)
    assert 'geometry' in report, report
    assert report['geometry']['optimistic_component_count'] == 11, report['geometry']
    assert 5 in [f['step'] for f in report['instructions']['failures']], report['instructions']
    print(json.dumps({'groups': report['geometry']['optimistic_component_count'],
                      'failed_steps': [f['step'] for f in report['instructions']['failures']]}), flush=True)
