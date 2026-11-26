"""Finished builds a v2 agent can be shown before it writes its own.

``library/`` holds build scripts converted from public model files: official sets from the LDraw
Official Model Repository, each model and each described submodel on its own, and the example
models of the toolkit's atlases. ``importer`` converts them and ``scripts/build_fable_examples.py``
builds the folder; ``NOTICE.md`` and ``SOURCES.md`` in it give the licences and credit every
file. ``index.jsonl`` lists every example with the plain-English description it is found by.

An example keeps the parts its set uses, stocked or not, and passes every check a Pip build must
pass apart from the catalog (``tests/test_fable_examples.py`` proves it on the real parts).

Examples are an option of a build, off unless asked for. When it is on, the examples closest to
the request are found by ``retrieval`` and added to the prompt, as many as fit ``PROMPT_BUDGET``.

A script starts with ``#:`` lines (``#: title: ...``). They credit the file and are not shown to
the model.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

LIBRARY = Path(__file__).parent / "library"
INDEX = "index.jsonl"
MOST_PARTS = 1200  # the largest example a prompt can hold whole; larger models are shown by their submodels
# Characters of example scripts one build is shown: about 11,000 tokens. At Pip's default model
# that is up to 3 cents on a first round that misses the provider's cache and a tenth of a cent
# on each later one.
PROMPT_BUDGET = 40_000
MOST_SHOWN = 5


@dataclass(frozen=True)
class Entry:
    """One line of the index: what an example is, without its script."""

    id: str  # "<set>/<name>", also its path under ``library`` without ".py"
    title: str  # the description it is found by
    kind: str  # "model" for a whole file, "submodel" for one section of it
    set: str  # the file it comes from; examples of one set share it
    parts: int
    chars: int  # the length of its script
    atlas: bool = False  # from the toolkit's example atlases, not an official set


@dataclass(frozen=True)
class Example:
    entry: Entry
    source: str
    author: str
    licence: str
    script: str  # without its ``#:`` lines


@lru_cache(maxsize=4)
def entries(library: Path = LIBRARY) -> tuple[Entry, ...]:
    """Every example of a library, in the order of its index. Empty when there is no index."""
    try:
        text = (library / INDEX).read_text(encoding="utf-8")
    except OSError:
        return ()
    return tuple(Entry(**json.loads(line)) for line in text.splitlines() if line.strip())


@lru_cache(maxsize=4)
def _by_id(library: Path = LIBRARY) -> dict[str, Entry]:
    return {entry.id: entry for entry in entries(library)}


def load(identity: str, library: Path = LIBRARY) -> Example:
    """One example with its script. Only an id the index lists is read, never a path."""
    entry = _by_id(library).get(identity)
    if entry is None:
        raise KeyError(identity)
    facts, body = {}, []
    for line in (library / f"{entry.id}.py").read_text(encoding="utf-8").splitlines():
        if line.startswith("#:") and not body:
            key, _, value = line[2:].partition(":")
            facts[key.strip()] = value.strip()
        else:
            body.append(line)
    return Example(entry, facts.get("source", ""), facts.get("author", ""), facts.get("licence", ""),
                   "\n".join(body).strip() + "\n")


def prompt_section(examples: Sequence[Example]) -> str:
    """What is added to the prompt of a build that was given these examples."""
    if not examples:
        return ""
    count = len(examples)
    parts = [
        f"# Example builds\n\nBelow {'is' if count == 1 else 'are'} {count} finished build"
        f"{'' if count == 1 else 's'} found for this request, written as plain `place` calls in building order. "
        "Each is a real LEGO set, or one section of one, and passes every check apart from the catalog. Read "
        "them for how such a thing is built: what stands on what, how wide and tall it is, which parts shape it, "
        "and how its details are attached. A whole model shows proportions and colors; a section shows how one "
        "piece of it is put together.\n\n"
        "An example may use parts and colors the catalog does not stock. Your own build may use catalog parts "
        "only: the report refuses anything else. When you want a part from an example, look it up first, and use "
        "the closest stocked part if it is not sold. Do not copy a design. Build what the request asks, in its "
        "colors and details, and use the helpers where they fit."]
    for example in examples:
        what = "whole model" if example.entry.kind == "model" else "one section of a model"
        parts.append(f"## {example.entry.title}\n\n({what}, {example.entry.parts} parts)\n\n"
                     f"```python\n{example.script.strip()}\n```")
    return "\n\n".join(parts)
