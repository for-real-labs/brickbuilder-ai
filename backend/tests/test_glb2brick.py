import importlib
import sys
import types

import numpy as np


def test_load_xyzrgb_to_voxel_array_keeps_single_voxel_files_two_dimensional(tmp_path, monkeypatch):
    fake_networkx = types.ModuleType("networkx")
    fake_networkx.Graph = object
    fake_networkx.single_source_shortest_path = lambda *_args, **_kwargs: {}
    fake_gurobipy = types.ModuleType("gurobipy")
    fake_gurobipy.GRB = types.SimpleNamespace(CONTINUOUS=0)
    fake_gurobipy.Model = object

    monkeypatch.setitem(sys.modules, "open3d", types.ModuleType("open3d"))
    monkeypatch.setitem(sys.modules, "networkx", fake_networkx)
    monkeypatch.setitem(sys.modules, "gurobipy", fake_gurobipy)

    for module_name in (
        "src.utils.conversions.glb2brick",
        "src.utils.conversions.voxel2brick",
        "src.utils.color_conversions",
        "src.stability_analysis.stability_analysis",
    ):
        sys.modules.pop(module_name, None)

    load_xyzrgb_to_voxel_array = importlib.import_module(
        "src.utils.conversions.glb2brick"
    ).load_xyzrgb_to_voxel_array

    xyzrgb = tmp_path / "single.xyzrgb"
    xyzrgb.write_text("4 5 6 255 128 64\n")

    voxels, colors, metadata = load_xyzrgb_to_voxel_array(str(xyzrgb))

    assert voxels.shape == (1, 1, 1)
    assert bool(voxels[0, 0, 0])
    assert np.allclose(colors[0, 0, 0], [1.0, 128 / 255.0, 64 / 255.0])
    assert metadata["grid_origin"].tolist() == [4, 5, 6]
    assert metadata["total_voxels"] == 1
