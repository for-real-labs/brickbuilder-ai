"""Jev adapter contract tests; all provider execution is mocked and offline."""
import asyncio

import pytest

from src.utils.nova_toolkit import NovaToolkit


@pytest.mark.parametrize("kind,source_field", [
    ("parts", "PARTS_DESCRIPTIONS_JEV.full_description"),
    ("models", "MODELS_DESCRIPTIONS_JEV.full_description"),
    ("submodels", "SUBMODELS_DESCRIPTIONS_JEV.full_description"),
])
def test_semantic_search_preserves_typed_corpus_identity_and_reports_actual_engine(monkeypatch, tmp_path, kind, source_field):
    monkeypatch.setenv("TYPESAFE_API_KEY", "offline-test-key")
    toolkit = NovaToolkit(tmp_path)
    commands = []
    report = {"kind": kind, "engine": "jev", "source_field": source_field,
              "results": [{"id": "reference-id", "score": .94, "source_field": source_field}]}
    async def run(arguments):
        commands.append(arguments)
        return report
    monkeypatch.setattr(toolkit, "run", run)
    response = asyncio.run(toolkit.search(kind, "arched roof", 5))
    assert commands == [["discover", "search", kind, "arched roof", "--engine", "jev", "--limit", "5", "--all-families"]]
    assert response["engine"] == "jev" and response["results"] is report
    assert "fallback_reason" not in response


@pytest.mark.parametrize("reported", [
    {"kind": "models", "engine": "fts", "results": []},
    {"kind": "parts", "engine": "jev", "results": []},
    {"kind": "models", "engine": "jev", "results": "not a list"},
    {"kind": "models", "engine": "jev", "results": [], "error": "provider unavailable"},
    {"results": []},
    [],
])
def test_failed_lexical_or_malformed_semantic_responses_are_never_labeled_jev(monkeypatch, tmp_path, reported):
    monkeypatch.setenv("TYPESAFE_API_KEY", "offline-test-key")
    toolkit = NovaToolkit(tmp_path)
    commands = []
    async def run(arguments):
        commands.append(arguments)
        return reported if arguments[0] == "discover" else {"results": [{"model": "roof.mpd"}], "query_language": "SQLite FTS5"}
    monkeypatch.setattr(toolkit, "run", run)
    response = asyncio.run(toolkit.search("models", "roof"))
    assert len(commands) == 2 and commands[1][:3] == ["search", "models", "roof"]
    assert response["engine"] == "fts" and response["fallback_reason"] == "semantic_unavailable"
    assert response["results"]["query_language"] == "SQLite FTS5"


def test_semantic_outage_does_not_echo_key_in_fallback_report(monkeypatch, tmp_path):
    monkeypatch.setenv("TYPESAFE_API_KEY", "never-forward-this-secret")
    toolkit = NovaToolkit(tmp_path)
    async def run(arguments):
        if arguments[0] == "discover":
            raise ValueError("Failed using never-forward-this-secret")
        return {"results": []}
    monkeypatch.setattr(toolkit, "run", run)
    response = asyncio.run(toolkit.search("submodels", "roof"))
    assert response["engine"] == "fts" and response["fallback_reason"] == "semantic_unavailable"
    assert "never-forward-this-secret" not in str(response)


@pytest.mark.parametrize("configured,use_jev", [(False, True), (True, False)])
def test_disabled_or_unconfigured_jev_never_invokes_a_semantic_provider(monkeypatch, tmp_path, configured, use_jev):
    if configured:
        monkeypatch.setenv("TYPESAFE_API_KEY", "offline-test-key")
    else:
        monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    toolkit = NovaToolkit(tmp_path, use_jev=use_jev)
    commands = []
    async def run(arguments):
        commands.append(arguments)
        return {"results": []}
    monkeypatch.setattr(toolkit, "run", run)
    response = asyncio.run(toolkit.search("submodels", "roof"))
    assert commands == [["search", "submodels", "roof", "--limit", "8"]]
    assert response["engine"] == "fts" and response["fallback_reason"] == "semantic_disabled_or_unconfigured"
