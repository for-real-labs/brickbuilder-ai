from pathlib import Path
from unittest.mock import Mock

import pytest
import trimesh

from src.utils.model_upload import obj_to_glb


def test_obj_becomes_resizable_glb_with_same_geometry_and_vertex_colors(tmp_path):
    source = tmp_path / 'colored.obj'
    source.write_text('v 0 0 0 1 0 0\nv 2 0 0 0 1 0\nv 0 3 0 0 0 1\nf 1 2 3\n')
    target = obj_to_glb(str(source))
    assert Path(target).suffix == '.glb'
    scene = trimesh.load(target, force='scene')
    mesh = next(iter(scene.geometry.values()))
    assert len(mesh.faces) == 1
    assert mesh.extents.tolist() == [2, 3, 0]
    assert mesh.visual.vertex_colors[:, :3].tolist() == [[255, 0, 0], [0, 255, 0], [0, 0, 255]]


def test_obj_never_resolves_external_material_files(tmp_path, monkeypatch):
    source = tmp_path / 'mesh.obj'
    source.write_text('mtllib /private/credentials.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
    resolver = Mock(side_effect=AssertionError('OBJ must not resolve external paths'))
    monkeypatch.setattr(trimesh.resolvers.FilePathResolver, '__getitem__', resolver)
    assert Path(obj_to_glb(str(source))).read_bytes().startswith(b'glTF')
    resolver.assert_not_called()


def test_obj_without_faces_is_rejected(tmp_path):
    source = tmp_path / 'empty.obj'
    source.write_text('v 0 0 0\n')
    with pytest.raises(ValueError, match='mesh with faces'):
        obj_to_glb(str(source))
