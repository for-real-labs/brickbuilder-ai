"""Import saved LDraw placements into a Pip build script, including nested submodels."""
import numpy as np
from fable_agent.examples.importer import read_file
from fable_agent.sandbox import MAX_SCRIPT_BYTES

from .ldraw_upload import normalize_ldraw_upload
from .parts_catalog import normalize_part_id


def source_script(content: bytes, max_parts: int) -> str:
    model = read_file(normalize_ldraw_upload("model.ldr", content))
    if not model:
        raise ValueError("The saved model is too large or empty.")
    lines = []
    visited = 0

    def walk(section, offset, rotation, inherited_color):
        nonlocal visited
        for color, position, matrix, name in model.sections[section].lines:
            visited += 1
            if visited > max_parts * 8 or len(lines) >= max_parts:
                raise ValueError("The saved model is too large for Pip to edit.")
            position = offset + rotation @ position
            matrix = rotation @ np.reshape(matrix, (3, 3))
            if not np.isfinite(position).all() or not np.isfinite(matrix).all():
                raise ValueError("The saved model has an invalid placement.")
            color = inherited_color if color == 16 else color
            if name.endswith(".dat"):
                part = normalize_part_id(name)
                xyz = ", ".join(format(n, ".9g") for n in position)
                turn = ", ".join(format(n, ".9g") for n in matrix.flat)
                lines.append(f"place_ldu({part!r}, {color}, ({xyz}), ({turn}))")
            elif name in model.sections:
                walk(name, position, matrix, color)
            else:
                raise ValueError("A submodel is missing from the saved model.")

    walk(model.first, np.zeros(3), np.eye(3), 16)
    script = "\n".join(lines)
    if not script or len(script.encode()) > MAX_SCRIPT_BYTES:
        raise ValueError("Pip could not import this model within its build limits.")
    return script
