"""BrickBuilder completion policy over Nova's geometry and connector evidence.

Run with the toolkit interpreter. No geometry, connector inference, or LDraw
parsing is implemented here. Every prefix of the exported step sequence must
have a single connected component, including parts added together in one step.
"""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from pathlib import Path

REVIEW_VERSION = 1
MAX_DIAGNOSTICS = 100


def review_connections(steps, contacts):
    """Incrementally review all step prefixes in O(parts + contacts) space."""
    if not steps or steps[0] != 1 or any(b not in (a, a + 1) for a, b in zip(steps, steps[1:])):
        raise ValueError('Missing or invalid instruction steps')
    edges = defaultdict(set)
    for contact in contacts:
        a, b = contact['instances']
        if (type(a) is not int or type(b) is not int or not 0 <= a < len(steps)
                or not 0 <= b < len(steps) or contact['status'] not in ('confirmed', 'potential')):
            raise ValueError('Incomplete connector evidence')
        edges[max(steps[a], steps[b])].add((a, b))
    parent, sizes, roots = {}, {}, set()

    def find(node):
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    by_step = defaultdict(list)
    for index, step in enumerate(steps):
        by_step[step].append(index)
    failures, failed_count = [], 0
    for step, nodes in by_step.items():
        for node in nodes:
            parent[node], sizes[node] = node, 1
            roots.add(node)
        for a, b in edges[step]:
            a, b = find(a), find(b)
            if a == b:
                continue
            if sizes[a] < sizes[b]:
                a, b = b, a
            parent[b] = a
            sizes[a] += sizes[b]
            roots.remove(b)
        if len(roots) != 1:
            failed_count += 1
            if len(failures) < MAX_DIAGNOSTICS:
                failures.append({'step': step, 'component_count': len(roots),
                                 'representative_instances': sorted(roots)[:20]})
    return {'checked': True, 'step_count': steps[-1], 'failed_step_count': failed_count,
            'failures': failures, 'failures_truncated': failed_count > len(failures),
            'final_component_count': len(roots)}


def review_model(source: Path, library: Path, output: Path):
    import ldraw_tools.common as common
    import ldraw_tools.document as document
    from ldraw_tools.geometry import analyze_geometry
    from ldraw_tools.validation import validate_file
    from flatten import MAX_INSTANCES, physical_occurrences, instruction_steps, serialize_placements

    # Scratch indexes are private to this unprivileged review, never an agent's
    # writable toolkit/cache or another owner's embedded-part definitions.
    common.CACHE = document.CACHE = output / 'cache'
    parts = common.get_parts(library)
    original, diagnostics = validate_file(source, parts, assembly=True, instance_limit=MAX_INSTANCES)
    report = {'version': REVIEW_VERSION, 'passed': False,
              'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
              'diagnostics': diagnostics, 'instructions': {'checked': False}}
    if original is not None and not any(d['severity'] == 'error' for d in diagnostics):
        physical, _ = document.physical_context(original, parts)
        occurrences = physical_occurrences(physical)
        # Force full-scene contacts, including models above Nova's auto threshold.
        # If the bounded report truncates any edges, fail closed instead of
        # inferring connectivity from a partial graph.
        geometry = analyze_geometry(original, parts, contacts='all', detail='full',
                                    output_limit=MAX_INSTANCES, pair_limit=20, instance_limit=MAX_INSTANCES)
        diagnostics.extend(geometry['diagnostics'])
        report['geometry'] = {key: geometry[key] for key in (
            'complete', 'occurrence_count', 'contacts_checked', 'contact_count', 'contacts_truncated',
            'confirmed_component_count', 'optimistic_component_count', 'connection_coverage')}
        complete = (geometry['complete'] is True and geometry['contacts_checked'] is True
                    and not geometry['contacts_truncated'] and not geometry['instances_truncated']
                    and geometry['occurrence_count'] == len(occurrences)
                    and geometry['contact_count'] == len(geometry['contacts']))
        if complete and occurrences:
            sequence = review_connections(instruction_steps(occurrences), geometry['contacts'])
            # Keep source attribution in repair feedback without retaining the
            # potentially huge connector/overlap report in the source archive.
            instances = {item['index']: item for item in geometry['instances']}
            for failure in sequence['failures']:
                failure['parts'] = [{key: instances[index][key] for key in
                                    ('index', 'part', 'section', 'line_number', 'source_path')}
                                   for index in failure.pop('representative_instances')]
            report['instructions'] = sequence
            report['passed'] = (sequence['failed_step_count'] == 0
                                and geometry['optimistic_component_count'] == 1
                                and not any(d['severity'] == 'error' for d in diagnostics))
        else:
            diagnostics.append({'code': 'build.connection_coverage', 'severity': 'error',
                                'message': 'Complete connector evidence for every placement is required.'})
        instructions = serialize_placements(original, occurrences, instructions=True)
        (output / 'instructions.ldr').write_text(instructions, encoding='utf-8')
        report['instructions_sha256'] = hashlib.sha256(instructions.encode()).hexdigest()
        display = serialize_placements(original, occurrences)
        (output / 'model.ldr').write_text(display, encoding='utf-8')
        report['display_sha256'] = hashlib.sha256(display.encode()).hexdigest()
    report['diagnostic_count'] = len(diagnostics)
    report['diagnostics'] = diagnostics[:MAX_DIAGNOSTICS]
    report['diagnostics_truncated'] = len(diagnostics) > MAX_DIAGNOSTICS
    report['physical_validity'] = 'not_proven'
    (output / 'build-review.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


if __name__ == '__main__':
    import sys
    review_model(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
