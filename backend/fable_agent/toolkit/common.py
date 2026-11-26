# Part of BrickBuilder's copy of the "ldraw-nova" agent toolkit.
# Copyright (c) 2026 Carlos Antelo and contributors (https://github.com/anteloc/ldraw-nova),
# with changes by Jake Johnson in his fork at commit d98e9fe6b82ea725322db0dbc74519159f204f5e.
# Licensed under the GNU Affero General Public License, version 3: see LICENSE-AGPL-3.0 at the
# root of this repository and NOTICE.md in this folder. There is NO WARRANTY.
# Modified by BrickBuilder, 2026-11-26: reduced to DATA, jsonable, issue, atomic_write and get_parts; get_parts takes
# the library root, cache folder and shadow sources as arguments instead of reading the environment.
"""Shared helpers of the copied toolkit modules."""
from __future__ import annotations

import dataclasses
from pathlib import Path

import numpy as np
from ldraw import Matrix, Vector

DATA = Path(__file__).parent / "data"


def jsonable(value):
    if isinstance(value, Vector):
        return [float(value.x), float(value.y), float(value.z)]
    if isinstance(value, Matrix):
        return value.rows
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    if hasattr(value, "to_dict"):
        return jsonable(value.to_dict())
    if dataclasses.is_dataclass(value):
        return {f.name: jsonable(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [jsonable(v) for v in value]
    return value


def issue(code, message, *, line=None, section=None, severity="error", **extra):
    return dict(code=code, severity=severity, message=message, line_number=line, section=section, **extra)


def atomic_write(path, text):
    import os
    from tempfile import NamedTemporaryFile
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", newline="", dir=path.parent, delete=False) as f:
            tmp = Path(f.name)
            f.write(text)
        os.replace(tmp, path)
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)


def get_parts(root, cache, shadows=()):
    """Supply pyldraw3's required index without writing into the source library.

    Adapted from the toolkit's ``get_parts``: the library root, the cache folder and the shadow
    sources are passed in, and nothing is read from the environment.
    """
    import hashlib
    from ldraw import Parts
    root = Path(root).expanduser().resolve()
    if not (root / "parts").is_dir() or not (root / "p").is_dir():
        raise ValueError(f"LDraw library missing at {root}")
    target = Path(cache) / ("library-" + hashlib.sha256(str(root).encode()).hexdigest()[:12])
    target.mkdir(parents=True, exist_ok=True)
    # Only a read-through view: library geometry and colour files remain authoritative.
    for entry in root.iterdir():
        if entry.name.lower() in {"parts", "p", "ldconfig.ldr"}:
            link = target / entry.name
            if not link.is_symlink():
                link.symlink_to(entry, target_is_directory=entry.is_dir())
    if not any(p.name.lower() == "ldconfig.ldr" for p in target.iterdir()):
        raise ValueError(f"LDConfig.ldr missing from {root}")
    files = sorted((root / "parts").glob("*.dat"))
    signature = hashlib.sha256("\n".join(
        f"{p.name}:{p.stat().st_size}:{p.stat().st_mtime_ns}" for p in files
    ).encode()).hexdigest()
    stamp = target / "signature"
    index = target / "parts.lst"
    if not index.exists() or not stamp.exists() or stamp.read_text() != signature:
        rows = []
        for p in files:
            with p.open(encoding="utf-8-sig", errors="replace") as f:
                title = next(f, "0").strip().removeprefix("0").strip()
            rows.append(f"{p.name} {title}")
        atomic_write(index, "\n".join(rows) + "\n")
        atomic_write(stamp, signature)
    parts = Parts(index)
    for source in shadows:
        parts.add_connection_shadow(Path(source))
    return parts
