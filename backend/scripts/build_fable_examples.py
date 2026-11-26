"""Build the Fable example library from a local checkout of annotated set models.

    python scripts/build_fable_examples.py --source /path/to/checkout [--only 50] [--jobs 8]

``--source`` is a folder with ``data/models-annotated/*.mpd`` (official sets, each model and
submodel described), ``data/ldraw-info.db`` (the same descriptions as a table) and
``examples/**/*.mpd`` (the example atlases). Every described model and submodel is converted to
a build script, held to the checks a Pip build must pass apart from the catalog, and written to
``fable_agent/examples/library`` with its credit. ``index.jsonl`` lists what was kept, and
``SOURCES.md`` credits every file. Nothing here runs during a build.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from fable_agent.examples import LIBRARY, MOST_PARTS  # noqa: E402
from fable_agent.examples.importer import Limits, SetImporter, flatten, read_file  # noqa: E402

ATLAS_LICENCE = "CC BY-SA 4.0 (ldraw-nova examples by Carlos Antelo)"
ANNOTATED = "LDraw Official Model Repository"
ATLAS = "ldraw-nova example atlas"
MAX_BYTES = 40 * 1024 * 1024
_importer = None


def records(source: Path) -> dict[Path, list[tuple[str | None, str]]]:
    """Each file with the sections that are described: ``(section or None for the model, description)``."""
    found: dict[Path, list] = defaultdict(list)
    models = source / "data" / "models-annotated"
    with sqlite3.connect((source / "data" / "ldraw-info.db").as_uri() + "?mode=ro", uri=True) as database:
        for (text,) in database.execute("SELECT full_description FROM MODELS_DESCRIPTIONS_JEV"):
            name, _, description = text.partition("|")
            found[models / name].append((None, description.strip()))
        for (text,) in database.execute("SELECT full_description FROM SUBMODELS_DESCRIPTIONS_JEV"):
            name, section, description = (text.split("|", 2) + ["", ""])[:3]
            found[models / name].append((section.strip(), description.strip()))
    for path in sorted((source / "examples").rglob("*.mpd")):
        found[path].append(("*", ""))  # an atlas file: every section, described by its own title
    return {path: wanted for path, wanted in found.items() if path.is_file()}


def _open() -> SetImporter:
    from fable_agent.assembly import AssemblyReview
    from fable_agent.catalog import PartFinder
    from fable_agent.checks import ModelChecker
    from fable_agent.connectors import ConnectorLibrary, ConnectorReview
    from fable_agent.ldraw import LDrawLibrary
    from fable_agent.palette import load_palette
    from fable_agent.shape import ShapeLibrary, default_cache_dir
    library = LDrawLibrary()
    shapes = ShapeLibrary(library, default_cache_dir())
    palette = load_palette(library, None, open_palette=True)  # examples are not held to the catalog
    assembly = AssemblyReview(library, shapes, ConnectorReview(ConnectorLibrary(library.root, default_cache_dir())))
    checker = ModelChecker(library, shapes, palette, max_parts=MOST_PARTS, assembly=assembly)
    return SetImporter(library, shapes, palette, PartFinder(library, palette), checker,
                       Limits(least_parts=3, most_parts=MOST_PARTS), assembly)


def convert_file(job: tuple[str, str, list]) -> list[dict]:
    """Every wanted section of one file that survives, as rows for the index with their script."""
    global _importer
    if _importer is None:
        _importer = _open()
    path, origin, wanted = Path(job[0]), job[1], job[2]
    try:
        raw = path.read_bytes()
    except OSError:
        return []
    if len(raw) > MAX_BYTES:
        return []
    import fable_agent.examples.importer as importer
    importer.MAX_FILE_BYTES = MAX_BYTES
    file = read_file(raw.decode("utf-8", errors="replace"), licence=ATLAS_LICENCE if origin == ATLAS else "")
    if file is None:
        return []
    if wanted and wanted[0][0] == "*":
        wanted = [(None if key == file.first else section.name, section.title)
                  for key, section in file.sections.items() if not key.endswith(".dat")]
    rows = []
    for section, description in wanted:
        key = (section or file.first).lower().strip()
        key = key if key in file.sections else next((k for k in file.sections if k.strip() == key), None)
        if key is None:
            continue
        model = flatten(file, key)
        if model is None or not (description or model.title):
            continue
        try:
            converted, reason = _importer.verdict(model)
        except Exception as exc:  # one odd file must not stop the run
            converted, reason = None, f"error: {type(exc).__name__}"
        if converted is None:
            rows.append({"refused": reason})
            continue
        rows.append({"file": path.name, "section": file.sections[key].name, "kind": "model" if section is None else "submodel",
                     "origin": origin, "title": (description or model.title).strip(), "author": model.author,
                     "licence": model.licence, "parts": converted.parts, "of": converted.of, "checked": converted.checked,
                     "script": converted.script})
    return rows


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "model"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--only", type=int, help="convert only this many files, for a trial run")
    parser.add_argument("--jobs", type=int, default=max(1, multiprocessing.cpu_count() - 2))
    parser.add_argument("--out", type=Path, default=LIBRARY)
    args = parser.parse_args()
    if any(args.out.glob("*/*.py")):
        # Stale scripts must not outlive the files they came from, and this script deletes nothing.
        parser.error(f"{args.out} already holds example scripts; move that folder away and run again")
    wanted = records(args.source.resolve())
    examples_root = args.source.resolve() / "examples"
    jobs = [(str(path), ATLAS if examples_root in path.parents else ANNOTATED, sections)
            for path, sections in sorted(wanted.items())]
    if args.only:
        jobs = jobs[:: max(1, len(jobs) // args.only)][: args.only]
    started = time.time()
    asked = sum(len(sections) for _, _, sections in jobs)
    kept: list[dict] = []
    refused: Counter = Counter()
    with multiprocessing.Pool(args.jobs) as pool:
        for done, rows in enumerate(pool.imap_unordered(convert_file, jobs, chunksize=1), 1):
            refused.update(row["refused"] for row in rows if "refused" in row)
            kept += [row for row in rows if "refused" not in row]
            if done % 25 == 0 or done == len(jobs):
                print(f"{done}/{len(jobs)} files, {len(kept)} examples, {time.time() - started:.0f}s", flush=True)
    write(kept, args.out)
    print(f"{len(kept)} of about {asked} described sections converted "
          f"({dict(Counter(row['kind'] for row in kept))}) in {time.time() - started:.0f}s")
    for reason, count in refused.most_common():
        print(f"  not used, {reason}: {count}")


def write(rows: list[dict], out: Path) -> None:
    """One script per example, without two that are the same build, and the index and credits."""
    rows.sort(key=lambda row: (row["origin"], row["file"], row["kind"] != "model", row["section"]))
    seen: set[str] = set()
    index, credits = [], []
    for row in rows:
        digest = hashlib.sha256(row["script"].encode()).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        folder = slug(Path(row["file"]).stem)
        name = slug(row["section"] if row["kind"] == "submodel" else "model")
        target = out / folder / f"{name}.py"
        number = 2
        while target.exists() or f"{folder}/{target.stem}" in {entry["id"] for entry in index[-50:]}:
            target = out / folder / f"{name}-{number}.py"
            number += 1
        target.parent.mkdir(parents=True, exist_ok=True)
        official = row["origin"] == ANNOTATED
        changes = ("converted to a BrickBuilder build script; moved to stand on the ground; "
                   f"{row['parts']} of {row['of']} parts kept (minifigures left out)")
        header = [f"#: title: {row['title']}",
                  f"#: source: {row['origin']}, {row['file']}" + (f", section {row['section']}" if row["kind"] == "submodel" else ""),
                  f"#: author: {row['author'] or 'not named in the file'}",
                  f"#: licence: {row['licence']}",
                  *(["#: description: by Carlos Antelo (ldraw-nova annotations), CC BY-SA 4.0"] if official else []),
                  f"#: changes: {changes}"]
        target.write_text("\n".join(header) + "\n" + row["script"], encoding="utf-8")
        identity = f"{folder}/{target.stem}"
        index.append({"id": identity, "title": row["title"], "kind": row["kind"], "set": folder, "parts": row["parts"],
                      "chars": len(row["script"]), "atlas": not official, "checked": row["checked"]})
        credits.append(f"| `{identity}.py` | {row['file']} | {row['author'] or '-'} | {row['licence']} | "
                       f"{row['parts']} of {row['of']} |")
    (out / "index.jsonl").write_text("".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in index),
                                     encoding="utf-8")
    (out / "SOURCES.md").write_text(
        "# Sources of the example scripts\n\n"
        "Every script in this folder is an adaptation of a model file, converted by `examples/importer.py`.\n"
        "See `NOTICE.md` for the licences and what was changed.\n\n"
        "| Example | Model file | Model file by | Licence of the file | Parts kept |\n|---|---|---|---|---|\n"
        + "\n".join(credits) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
