"""Finding the examples closest to a request.

Every example has a plain-English description of what it is. A request is matched against them
in two steps, the way the toolkit's reference discovery does it: a keyword search shortlists the
descriptions that share words with the request, and Jev, a semantic reranker, scores how well
each of those matches what was asked. The best few that fit the prompt are returned, at most two
from one set, so a request for a fire station gets fire stations and not whichever buildings
come first.

Jev is a paid service reached through the ``jev-rerank`` command and needs ``TYPESAFE_API_KEY``.
When the command, the key or the service is missing, the keyword ranking is used on its own and
the result says so. Retrieval never stops a build: any failure yields no examples and a note.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from . import LIBRARY, MOST_SHOWN, PROMPT_BUDGET, Entry, Example, entries, load

JEV_MODEL = "jev-1.13.0"
JEV_COMMAND = "jev-rerank"
JEV_USD_PER_MILLION_INPUT_TOKENS = Decimal("0.042")  # output tokens are free (docs.typesafe.ai/models, 2026-11)
CANDIDATES = 300  # descriptions the keyword search hands to Jev; its cost grows with this
POOL = 40  # ranked results asked for, enough to fill the prompt after leaving out what does not fit
PER_SET = 2
TIMEOUT_SECONDS = 45
QUERY_CHARS = 2000
STOP_WORDS = frozenset("a an the with for of and to in on from that this is it as at by be me my i please build "
                       "make create lego model set".split())


@dataclass(frozen=True)
class Retrieval:
    """What was found for one request, and what finding it cost."""

    examples: tuple[Example, ...] = ()
    engine: str = "none"  # "jev", "keywords" or "none"
    note: str = ""  # why Jev was not used, or why nothing was found
    seconds: float = 0.0
    input_tokens: int = 0
    cost_usd: Decimal = Decimal(0)

    def record(self) -> dict:
        """For the build's own record: which examples, found how, at what cost."""
        return {"engine": self.engine, "note": self.note, "seconds": round(self.seconds, 2),
                "input_tokens": self.input_tokens, "estimated_cost_usd": str(self.cost_usd),
                "examples": [example.entry.id for example in self.examples]}


class JevUnavailable(RuntimeError):
    """Jev could not rank this request; the keyword ranking stands in."""


Runner = Callable[..., subprocess.CompletedProcess]


class ExampleFinder:
    def __init__(self, cache_dir: Path | str, *, library: Path = LIBRARY, api_key: str | None = None,
                 command: str = JEV_COMMAND, runner: Runner = subprocess.run, budget: int = PROMPT_BUDGET):
        self._cache = Path(cache_dir) / "examples"
        self._library = library
        self._key = os.environ.get("TYPESAFE_API_KEY", "") if api_key is None else api_key
        self._command = command
        self._runner = runner
        self._budget = budget

    def find(self, request: str) -> Retrieval:
        started = time.monotonic()
        try:
            return self._find(request, started)
        except Exception as exc:  # an example is a help, never a reason to fail a build
            return Retrieval(note=f"examples could not be searched ({type(exc).__name__})",
                             seconds=time.monotonic() - started)

    def _find(self, request: str, started: float) -> Retrieval:
        listed = entries(self._library)
        query = " ".join(request.split())[:QUERY_CHARS]
        if not listed or not query:
            return Retrieval(note="the example library is empty" if not listed else "the request has no words")
        database = self._index(listed)
        engine, note, tokens = "jev", "", 0
        try:
            ranked, tokens = self._jev(database, query)
        except JevUnavailable as exc:
            engine, note = "keywords", f"Jev was not used ({exc}); examples were ranked by shared words"
            ranked = self._keywords(database, query)
        chosen = self._fitting(ranked, {entry.id: entry for entry in listed})
        cost = (Decimal(tokens) * JEV_USD_PER_MILLION_INPUT_TOKENS / Decimal(1_000_000)).quantize(Decimal("0.000001"))
        if not chosen:
            note = (note + "; " if note else "") + "no example matched the request"
        return Retrieval(tuple(load(entry.id, self._library) for entry in chosen), engine if chosen else "none", note,
                         time.monotonic() - started, tokens, cost)

    # ----- the search index ----------------------------------------------

    def _index(self, listed: tuple[Entry, ...]) -> Path:
        """A SQLite file of the descriptions, rebuilt when the library changes."""
        signature = hashlib.sha256("\n".join(f"{entry.id}\t{entry.title}" for entry in listed).encode()).hexdigest()
        path = self._cache / f"descriptions-{signature[:16]}.sqlite"
        if path.is_file():
            return path
        self._cache.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".{os.getpid()}.tmp")
        with sqlite3.connect(temporary) as database:
            database.execute("CREATE TABLE candidates(id TEXT PRIMARY KEY, full_description TEXT NOT NULL)")
            database.execute("CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, body)")
            database.executemany("INSERT INTO candidates VALUES(?,?)", [(entry.id, entry.title) for entry in listed])
            database.executemany("INSERT INTO search VALUES(?,?)", [(entry.id, entry.title) for entry in listed])
        os.replace(temporary, path)
        return path

    # ----- ranking -------------------------------------------------------

    def _jev(self, database: Path, query: str) -> tuple[list[str], int]:
        if not self._key:
            raise JevUnavailable("TYPESAFE_API_KEY is not set")
        if self._runner is subprocess.run and shutil.which(self._command) is None:
            raise JevUnavailable(f"the {self._command} command is not installed")
        command = [self._command, "--db", str(database), "--table-field", "candidates.full_description",
                   "--query", json.dumps({"query": query, "yes": "a LEGO model or part of one that would help build this",
                                          "no": "an unrelated model"}),
                   "--top", str(POOL), "--candidates", str(CANDIDATES), "--model", JEV_MODEL,
                   "--cache-dir", str(self._cache / "jev"), "--json", "--show", "--quiet"]
        # The command gets the key and a home for its files; nothing else of the API's environment.
        environment = {"TYPESAFE_API_KEY": self._key, "PATH": os.environ.get("PATH", ""),
                       "HOME": os.environ.get("HOME", str(self._cache))}
        try:
            done = self._runner(command, capture_output=True, text=True, timeout=TIMEOUT_SECONDS, env=environment)
        except (OSError, subprocess.SubprocessError) as exc:
            raise JevUnavailable(type(exc).__name__) from None
        if done.returncode:
            raise JevUnavailable(f"the search failed with status {done.returncode}")
        try:
            data = json.loads(done.stdout)
            ranked = [str(row["source"]["key"]["id"]) for row in data["results"]]
            tokens = int(data.get("stats", {}).get("input_tokens", 0))
        except (ValueError, KeyError, TypeError):
            raise JevUnavailable("the search returned an answer that could not be read") from None
        return ranked, tokens

    @staticmethod
    def _keywords(database: Path, query: str) -> list[str]:
        words = [word for word in re.findall(r"\w+", query.casefold()) if word not in STOP_WORDS]
        if not words:
            return []
        expression = " OR ".join(f'"{word}"' for word in dict.fromkeys(words))
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
            return [row[0] for row in connection.execute(
                "SELECT id FROM search WHERE search MATCH ? ORDER BY rank, id LIMIT ?", (expression, POOL))]

    def _fitting(self, ranked: list[str], known: dict[str, Entry]) -> list[Entry]:
        """The best-ranked examples that fit the prompt together, a few per set."""
        chosen: list[Entry] = []
        used, per_set = 0, Counter()
        for identity in ranked:
            entry = known.get(identity)
            if entry is None or entry in chosen or per_set[entry.set] >= PER_SET or used + entry.chars > self._budget:
                continue
            chosen.append(entry)
            used += entry.chars
            per_set[entry.set] += 1
            if len(chosen) == MOST_SHOWN:
                break
        return chosen
