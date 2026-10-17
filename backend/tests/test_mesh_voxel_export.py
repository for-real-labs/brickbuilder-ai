import json
import struct
from pathlib import Path

import numpy as np
import pytest
import trimesh

from src.utils.mesh_voxel_export import convert_mesh, validate_glb, write_binvox, write_qb


@pytest.mark.parametrize('source_format', ['obj', 'glb'])
@pytest.mark.parametrize('output_format', ['vox', 'qb', 'binvox', 'xyzrgb'])
def test_real_mesh_converts_to_every_advertised_format(tmp_path, source_format, output_format):
    mesh = trimesh.creation.box(extents=[1, 2, 3])
    mesh.visual.vertex_colors = [220, 30, 70, 255]
    source = tmp_path / f'box.{source_format}'
    mesh.export(source)
    output = tmp_path / f'model.{output_format}'
    convert_mesh(source, output, 8)
    data = output.read_bytes()
    assert len(data) > 50
    if output_format == 'vox':
        assert data.startswith(b'VOX ')
        count = struct.unpack_from('<I', data, data.index(b'XYZI') + 12)[0]
        assert count > 20
        assert b'\xdc\x1e\x46\xff' in data[data.index(b'RGBA') + 12:]
    elif output_format == 'qb':
        assert struct.unpack_from('<6I', data) == (257, 0, 1, 0, 0, 1)
        assert b'\xdc\x1e\x46\xff' in data
    elif output_format == 'binvox':
        imported = trimesh.exchange.binvox.load_binvox(output.open('rb'))
        assert imported.filled_count > 20
    else:
        rows = np.loadtxt(output, dtype=int)
        assert rows.shape[1] == 6
        assert np.all(rows[:, 3:] == [220, 30, 70])


def test_qb_axis_order_empty_cells_and_rgba(tmp_path):
    path = tmp_path / 'model.qb'
    coords = np.array([[0, 0, 0], [1, 2, 3]])
    colors = np.array([[12, 34, 56], [78, 90, 123]])
    write_qb(path, coords, colors)
    data = path.read_bytes()
    offset = 25 + data[24]
    assert struct.unpack_from('<3I3i', data, offset) == (2, 3, 4, 0, 0, 0)
    rgba = np.frombuffer(data[offset + 24:], dtype=np.uint8).reshape(4, 3, 2, 4)
    assert rgba[0, 0, 0].tolist() == [12, 34, 56, 255]
    assert rgba[3, 2, 1].tolist() == [78, 90, 123, 255]
    assert np.count_nonzero(rgba[:, :, :, 3]) == 2


def test_binvox_round_trips_asymmetric_coordinates_and_long_runs(tmp_path):
    path = tmp_path / 'model.binvox'
    coords = np.array([[0, 0, 0], [2, 4, 8], [1, 3, 7]])
    write_binvox(path, coords)
    with path.open('rb') as stream:
        grid = trimesh.exchange.binvox.load_binvox(stream)
    assert grid.shape == (9, 9, 9)
    assert sorted(grid.sparse_indices.tolist()) == sorted(coords.tolist())
    encoded = path.read_bytes().split(b'data\n')[1]
    assert all(encoded[i] in (0, 1) and encoded[i + 1] > 0 for i in range(0, len(encoded), 2))


def glb_json(tmp_path, document):
    raw = json.dumps(document).encode()
    raw += b' ' * (-len(raw) % 4)
    path = tmp_path / 'unsafe.glb'
    path.write_bytes(struct.pack('<4sIIII', b'glTF', 2, len(raw) + 20, len(raw), 0x4E4F534A) + raw)
    return path


@pytest.mark.parametrize('uri', ['/etc/passwd', '../private.bin', 'https://example.com/texture.png', 'file:///etc/passwd'])
def test_glb_external_resources_rejected_before_loading(tmp_path, uri):
    with pytest.raises(ValueError, match='embedded'):
        validate_glb(glb_json(tmp_path, {'images': [{'uri': uri}]}))


def test_invalid_and_oversized_meshes_rejected(tmp_path, monkeypatch):
    source = glb_json(tmp_path, {})
    mesh = trimesh.creation.box()
    mesh.faces = np.tile(mesh.faces, (21_000, 1))
    monkeypatch.setattr(trimesh, 'load', lambda *a, **k: trimesh.Scene(mesh))
    with pytest.raises(ValueError, match='250,000'):
        convert_mesh(source, tmp_path / 'out.vox', 8)
    source.write_bytes(b'not a glb')
    with pytest.raises(ValueError, match='header'):
        validate_glb(source)
