"""Runtime review receipts for transport tests; geometry has its own tests."""
import hashlib


def receipt(mpd, ldr, instructions):
    return {'version': 1, 'passed': True,
            'source_sha256': hashlib.sha256(mpd.encode()).hexdigest(),
            'display_sha256': hashlib.sha256(ldr.encode()).hexdigest(),
            'instructions_sha256': hashlib.sha256(instructions.encode()).hexdigest(),
            'geometry': {'complete': True, 'contacts_checked': True, 'contacts_truncated': False,
                         'optimistic_component_count': 1},
            'instructions': {'checked': True, 'failed_step_count': 0, 'final_component_count': 1}}
