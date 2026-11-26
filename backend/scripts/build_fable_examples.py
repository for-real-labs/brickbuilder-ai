"""Rebuild the official-set examples of the Fable agents from downloaded model files.

    cd backend
    uv run python scripts/build_fable_examples.py MODELS_DIR [--sets sets.csv.gz --themes themes.csv.gz]

MODELS_DIR holds .mpd or .ldr files from the LDraw Official Model Repository
(https://library.ldraw.org/omr). The set number is read from each file name (``4903-1``), and a
name after it (``..._Jet.mpd``) is taken as the model's own name when a set builds several.
``--sets`` and ``--themes`` are Rebrickable's free tables (https://rebrickable.com/downloads/):
they give each set its official name and theme, which decide its category.

Every file that is licensed for reuse is converted by ``fable_agent.examples.importer`` and kept
only if it passes the checks a Pip build must pass. The kept scripts replace the official-set
examples in ``fable_agent/examples/library``; examples written by hand are left alone.
``fable_agent/examples/SOURCES.md`` is rewritten with the credit each licence asks for.

Nothing is downloaded here, and the model files themselves are never copied into the repository.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fable_agent.app import Workbench  # noqa: E402
from fable_agent.examples import BY_ID, LIBRARY, OFFICIAL, _read  # noqa: E402
from fable_agent.examples.importer import SetImporter, categorize, read_model  # noqa: E402

SET_NUMBER = re.compile(r"(?<![0-9a-z])(\d{3,7}[a-z]?-\d+)(?:_([^.]+))?\.(?:mpd|ldr)$", re.IGNORECASE)
MAX_BYTES = 8 * 1024 * 1024


def _table(path: Path | None) -> list[dict]:
    if path is None:
        return []
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def official_names(sets: Path | None, themes: Path | None) -> dict[str, tuple[str, str]]:
    """Set number -> (official name, theme with its parents), from Rebrickable's tables."""
    by_id = {row["id"]: row for row in _table(themes)}

    def theme(identifier: str) -> str:
        names = []
        while identifier in by_id and len(names) < 5:
            names.append(by_id[identifier]["name"])
            identifier = by_id[identifier].get("parent_id") or ""
        return " / ".join(reversed(names))

    return {row["set_num"].lower(): (row["name"], theme(row.get("theme_id", ""))) for row in _table(sets)}


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:48] or "model"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("models", type=Path)
    parser.add_argument("--sets", type=Path)
    parser.add_argument("--themes", type=Path)
    args = parser.parse_args()
    names = official_names(args.sets, args.themes)
    bench = Workbench.open({"ldraw_dir": None, "catalog_path": None, "open_palette": False, "max_parts": 5000,
                            "assembly_rules": True})
    importer = SetImporter(bench.library, bench.shapes, bench.palette, bench.finder, bench.checker)

    for old in LIBRARY.glob("*/*.py"):  # the official sets are rebuilt from scratch; written examples stay
        if _read(old).official:
            old.unlink()
    outcome, credits, scripts = Counter(), [], set()
    for path in sorted(args.models.iterdir()):
        named = SET_NUMBER.search(path.name)
        if not named or not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_BYTES:
            continue
        model = read_model(path.read_text(encoding="utf-8", errors="replace"))
        if model is None:
            outcome["not licensed for reuse, or unreadable"] += 1
            continue
        number = named.group(1).lower()
        official, theme = names.get(number, (model.title, model.theme))
        own = (named.group(2) or "").replace("-", " ").replace("_", " ").strip()
        title = f"{own} (from {official})" if own and own.lower() not in official.lower() else official
        category = categorize(own or official, theme or model.theme)
        if category is None:
            outcome["no category"] += 1
            continue
        try:
            converted = importer.convert(model)
        except Exception:  # noqa: BLE001 - one odd file must not stop the rest
            converted = None
        if converted is None:
            outcome["does not pass Pip's checks intact"] += 1
            continue
        if converted.script in scripts:  # the same model released under two set numbers
            outcome["same as another set"] += 1
            continue
        scripts.add(converted.script)
        target = LIBRARY / category / f"set_{_slug(number)}_{_slug(own or official)}.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        credit = f"{OFFICIAL}, set {number}, model file by {model.author or 'an LDraw contributor'}"
        target.write_text(f"#: title: {title}, official set {number}\n#: source: {credit}\n"
                          f"#: licence: {model.licence}\n"
                          f"#: changes: converted to a build script; {converted.of - converted.parts} of "
                          f"{converted.of} parts left out\n{converted.script}", encoding="utf-8")
        outcome["kept"] += 1
        credits.append((category, number, title, model.author, model.licence, converted.parts, converted.of))

    lines = ["# Sources of the example scripts", "",
             "The scripts under `library/` whose first lines name the " + OFFICIAL + " are adaptations of",
             "model files from https://library.ldraw.org/omr, used under the licence each file carries",
             "(Creative Commons Attribution, CCAL 2.0 or CC BY 4.0). Each was converted to a BrickBuilder build",
             "script by `importer.py`: parts the catalog does not stock or the checks cannot join were left out,",
             "and colors were moved to the nearest stocked one. LEGO is a trademark of the LEGO Group, which",
             "does not sponsor or endorse BrickBuilder. The other scripts were written for BrickBuilder.", "",
             "| Category | Set | Example | Model file by | Licence | Parts kept |", "|---|---|---|---|---|---|"]
    lines += [f"| {category} | {number} | {title} | {author or 'an LDraw contributor'} | {licence} | {kept} of {of} |"
              for category, number, title, author, licence, kept, of in sorted(credits)]
    (LIBRARY.parent / "SOURCES.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(dict(outcome))
    print({category: len(list((LIBRARY / category).glob("*.py"))) for category in BY_ID})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
