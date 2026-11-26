"""Finished build scripts a v2 agent can be shown before it writes its own, sorted by subject.

``library/<category>/`` holds the scripts. Some were written for BrickBuilder with the helpers.
The rest are official sets from the LDraw Official Model Repository, converted to plain
``place`` calls by ``importer`` and credited in ``SOURCES.md``. Every script passes the checks a
Pip build must pass, which ``tests/test_fable_examples.py`` proves on the real parts.

Examples are an option of a build, off unless asked for. When it is on, the model first names
the category that fits the request (see ``chooser``), and that category's scripts are added to
its prompt, as many as fit ``PROMPT_BUDGET``.

A script may start with ``#:`` lines (``#: title: ...``). They describe the file and are not
shown to the model.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

LIBRARY = Path(__file__).parent / "library"
# Characters of example scripts one build is shown: about 8,500 tokens, which costs about 2 cents
# on the first round and a tenth of a cent on each later one at Pip's default model.
PROMPT_BUDGET = 30_000
OFFICIAL = "LDraw Official Model Repository"


@dataclass(frozen=True)
class Category:
    id: str
    covers: str  # what the model is told the category holds, when it chooses
    shows: str  # what its examples are worth reading for


CATEGORIES = (
    Category("cars", "cars, taxis, police cars, jeeps, pickups, vans, tractors and race cars",
             "where the body starts on the chassis, what the windscreen stands on, which cells to leave free for "
             "lights and seats, and how the roof is carried"),
    Category("aircraft", "planes, seaplanes and helicopters",
             "how wings, a tail and a cockpit are stacked on a narrow body"),
    Category("boats", "boats and ships", "how a hull is layered and where the cabin sits on it"),
    Category("trains", "locomotives and trains", "how a long body is carried and where its details go"),
    Category("spacecraft", "spaceships and star fighters", "how a wedge or wing shape is layered in plates"),
    Category("houses", "houses, cabins, cottages and lake houses",
             "what the walls stand on, which walls cover the corners, how each opening gets its window or door, "
             "what the roof rests on, and how porches and decks meet the floor"),
    Category("buildings", "shops, stations, hospitals, towers, skyscrapers, lighthouses and windmills",
             "what each floor and wall stands on, how a second floor or a tower is stacked, and what the roof "
             "rests on"),
    Category("castles", "castles and forts",
             "how towers, curtain walls and a gate meet, and what a keep stands on"),
    Category("animals", "animals and creatures", "how a body, legs, a head and a tail are told apart in few parts"),
    Category("characters", "figures, mascots and seasonal characters such as a pumpkin or a ghost",
             "how a face and a rounded body are suggested with plain bricks"),
    Category("flat", "flags and other flat pictures", "how a picture is laid out in rows of plates"),
)
BY_ID = {category.id: category for category in CATEGORIES}


@dataclass(frozen=True)
class Example:
    category: str
    name: str
    title: str
    source: str
    script: str  # without its ``#:`` lines

    @property
    def official(self) -> bool:
        return self.source.startswith(OFFICIAL)


def _read(path: Path) -> Example:
    facts, body = {}, []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#:") and not body:
            key, _, value = line[2:].partition(":")
            facts[key.strip()] = value.strip()
        else:
            body.append(line)
    return Example(path.parent.name, path.stem, facts.get("title") or path.stem.replace("_", " "),
                   facts.get("source", ""), "\n".join(body).strip() + "\n")


@lru_cache(maxsize=None)
def load(category: str) -> tuple[Example, ...]:
    """Every example of a category: the written ones first, then the official sets from small to large."""
    if category not in BY_ID:
        raise KeyError(category)
    found = [_read(path) for path in sorted((LIBRARY / category).glob("*.py"))]
    return tuple(sorted(found, key=lambda example: (example.official, len(example.script) if example.official else 0,
                                                   example.name)))


def shown(category: str, budget: int = PROMPT_BUDGET) -> tuple[Example, ...]:
    """The examples of a category that a build is shown: in order, as many as fit the budget."""
    chosen, used = [], 0
    for example in load(category):
        if used + len(example.script) <= budget:
            chosen.append(example)
            used += len(example.script)
    return tuple(chosen)


def stocked_categories() -> tuple[Category, ...]:
    """The categories that have at least one example."""
    return tuple(category for category in CATEGORIES if load(category.id))


def prompt_section(category: str) -> str:
    """What is added to the prompt of a build that was given this category's examples."""
    examples = shown(category)
    kind = BY_ID[category]
    sets = sum(example.official for example in examples)
    origin = ""
    if sets:
        origin = (f" {sets} of them {'is an official LEGO set' if sets == 1 else 'are official LEGO sets'}, "
                  "written as plain `place` calls in building order, without the parts the checks cannot join "
                  "(minifigures, clipped and hinged parts).")
    parts = [f"# Example scripts: {kind.covers}\n\nBelow {'is' if len(examples) == 1 else 'are'} {len(examples)} "
             f"finished script{'' if len(examples) == 1 else 's'}. Each passes every check.{origin} Read them to see "
             f"{kind.shows}. Do not copy a design: build what the request asks, in its colors and details, and "
             "use the helpers where they fit."]
    for example in examples:
        parts.append(f"## {example.title}\n\n```python\n{example.script.strip()}\n```")
    return "\n\n".join(parts)
