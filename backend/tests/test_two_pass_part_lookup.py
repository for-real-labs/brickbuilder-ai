import json
from types import SimpleNamespace

import pytest
from experiments.two_pass import agent, part_lookup


def test_real_command_contract_and_bounded_connector_samples(tmp_path, monkeypatch):
    script = tmp_path / "ldraw-agent"
    script.touch(mode=0o755)
    monkeypatch.setenv("LDRAW_NOVA_TOOLKIT_DIR", str(tmp_path))
    monkeypatch.setenv("LDRAW_DIR", str(tmp_path / "library"))
    frame = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
    connectors = [
        {"kind": "stud", "role": "male", "frame": frame, "position": [x, 0, 0]}
        for x in range(20)
    ]
    connectors.append(
        {"kind": "pin_hole", "role": "female", "frame": frame, "position": [0, 10, 0]}
    )
    report = {
        "code": "4070.dat",
        "bounds": {"min": [-10, -4, -10], "max": [10, 24, 10]},
        "size": [20, 28, 20],
        "complete": False,
        "connection_metadata": {"coverage": "partial"},
        "connector_count": 22,
        "connectors": connectors,
    }

    def nova(argv, *, cwd, **kwargs):
        assert argv == [
            str(script),
            "--library",
            str(tmp_path / "library"),
            "part",
            "4070",
            "--limit",
            "64",
        ]
        assert cwd == tmp_path
        return SimpleNamespace(returncode=1, stdout=json.dumps(report))

    monkeypatch.setattr(part_lookup.subprocess, "run", nova)
    facts = part_lookup.inspect_part("4070")
    assert facts["geometry_complete"] is False
    assert facts["connector_count"] == 22 and facts["coverage"] == "partial"
    assert facts["examples"] == [
        ["stud", "male", [0, 0, 0], frame],
        ["pin_hole", "female", [0, 10, 0], frame],
    ]


def test_failed_draft_inspects_repeat_and_supplied_parts_only(tmp_path, monkeypatch):
    parts = {
        (p, 4): SimpleNamespace(max_quantity=qty, name=name)
        for p, name, qty in [
            ("3001", "Brick", None),
            ("4070", "Headlight", None),
            ("3823", "Door", 0),
            ("54200", "Slope", None),
        ]
    }
    calls = []
    reads = []

    def measure(part):
        reads.append(part)
        return {"size": [20, 24, 20]}

    def invoke(model, guide, prompt, images, budget):
        calls.append(prompt)
        if len(calls) == 1:
            return json.dumps(
                [
                    ["repeat", 2, 1, 0, 0, ["part", 4, 0, 0, 0, "54200.dat", 0]],
                    ["part", 4, 0, 0, 0, "../../other", 0],
                ]
            ), {"cost": 0.01}
        return '{"replace":[["part",4,0,0,0,"54200",0]]}', {"cost": 0.01}

    monkeypatch.setattr(part_lookup, "inspect_part", measure)
    monkeypatch.setattr(agent, "invoke", invoke)
    result = agent.run(
        "astra",
        "headlight and door",
        [],
        tmp_path,
        SimpleNamespace(parts=parts),
        8,
        lambda *args: [tmp_path / "view.png"],
    )
    assert result["model"] == "stage2.mpd"
    assert '"4070":' in calls[0] and '"54200":' not in calls[0]
    assert '"54200":' in calls[1] and "Unavailable part/color" in calls[1]
    assert reads == ["4070", "3001", "54200"]


def test_edit_reads_source_parts_once(tmp_path, monkeypatch):
    source = ["1 0 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat"]
    catalog = SimpleNamespace(
        parts={
            ("3001", c): SimpleNamespace(name="Brick", max_quantity=None)
            for c in (0, 4)
        }
    )
    prompts, reads = [], []

    def measure(part):
        reads.append(part)
        return {"connector_count": 16}

    def invoke(model, guide, prompt, images, budget):
        prompts.append(prompt)
        return ('{"recolor":[[0,4]]}' if len(prompts) == 1 else '{"keep":true}'), {
            "cost": 0.01
        }

    monkeypatch.setattr(part_lookup, "inspect_part", measure)
    monkeypatch.setattr(agent, "invoke", invoke)
    result = agent.run(
        "astra",
        "make it red",
        [],
        tmp_path,
        catalog,
        5,
        lambda *args: [tmp_path / "view.png"],
        source=source,
    )
    assert result["model"] == "stage2.mpd" and reads == ["3001"]
    assert all('"connector_count":16' in text for text in prompts)


def test_missing_nova_stops_before_paid_calls(tmp_path, monkeypatch):
    monkeypatch.setenv("LDRAW_NOVA_TOOLKIT_DIR", str(tmp_path / "missing"))
    monkeypatch.setattr(
        agent, "invoke", lambda *args: pytest.fail("unexpected provider call")
    )
    catalog = SimpleNamespace(
        parts={("3001", 4): SimpleNamespace(name="Brick", max_quantity=None)}
    )
    with pytest.raises(RuntimeError, match="configured Nova toolkit"):
        agent.run("astra", "brick", [], tmp_path, catalog, 10, None)
    assert not (tmp_path / "reservation.json").exists()
