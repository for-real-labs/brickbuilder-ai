"""Mesh-to-voxel worker and interchange writers; no brick optimization required."""
import json
import struct
import sys
from pathlib import Path

import numpy as np
import trimesh

from .model_upload import obj_to_glb
from .conversions.trimesh_voxelizer import glb_to_xyzrgb, _parse_xyzrgb, write_vox_from_xyzrgb

OUTPUT_FORMATS = frozenset({'vox', 'qb', 'binvox', 'xyzrgb'})


def validate_glb(path: Path) -> None:
    """Only accept GLB 2 with embedded resources, never external file/URL reads."""
    with path.open('rb') as source:
        header = source.read(20)
        if len(header) != 20:
            raise ValueError('Invalid GLB header')
        magic, version, length, json_length, chunk_type = struct.unpack('<4sIIII', header)
        if (magic != b'glTF' or version != 2 or length != path.stat().st_size
                or chunk_type != 0x4E4F534A or json_length > length - 20):
            raise ValueError('Upload a valid GLB 2 file')
        document = json.loads(source.read(json_length))
    for resource in document.get('buffers', []) + document.get('images', []):
        uri = resource.get('uri', '')
        if uri and not uri.startswith('data:'):
            raise ValueError('GLB resources must be embedded')


def write_qb(path: Path, coords: np.ndarray, colors: np.ndarray) -> None:
    """Qubicle Binary 1.1: one uncompressed RGBA matrix, right-handed Z."""
    dims = coords.max(axis=0) + 1
    # QB scans x fastest, then y, then z. Alpha 0 means unoccupied.
    data = np.zeros((int(dims[2]), int(dims[1]), int(dims[0]), 4), dtype=np.uint8)
    data[coords[:, 2], coords[:, 1], coords[:, 0], :3] = colors
    data[coords[:, 2], coords[:, 1], coords[:, 0], 3] = 255
    name = b'Model'
    header = struct.pack('<6I', 257, 0, 1, 0, 0, 1)
    matrix = bytes([len(name)]) + name + struct.pack('<3I3i', *dims, 0, 0, 0)
    path.write_bytes(header + matrix + data.tobytes())


def write_binvox(path: Path, coords: np.ndarray) -> None:
    """BINVOX 1: cubic occupancy grid, y fastest, then z, then x."""
    size = int(coords.max()) + 1
    grid = np.zeros((size, size, size), dtype=np.uint8)
    grid[coords[:, 0], coords[:, 2], coords[:, 1]] = 1
    flat = grid.ravel()
    encoded = bytearray()
    value, count = int(flat[0]), 0
    for voxel in flat:
        if int(voxel) != value or count == 255:
            encoded.extend((value, count))
            value, count = int(voxel), 0
        count += 1
    encoded.extend((value, count))
    # Coordinates refer to the normalized voxel grid, rather than source units.
    header = f'#binvox 1\ndim {size} {size} {size}\ntranslate 0 0 0\nscale 1\ndata\n'
    path.write_bytes(header.encode('ascii') + encoded)


def convert_mesh(source: Path, output: Path, resolution: int) -> None:
    if source.suffix not in {'.glb', '.obj'} or output.suffix[1:] not in OUTPUT_FORMATS:
        raise ValueError('Unsupported conversion')
    if not 8 <= resolution <= 64:
        raise ValueError('Resolution must be between 8 and 64')
    if source.suffix == '.glb':
        validate_glb(source)
        glb = source
    else:
        glb = Path(obj_to_glb(str(source)))
    with glb.open('rb') as stream:
        scene = trimesh.load(stream, file_type='glb', force='scene', resolver=None, process=False)
    meshes = [mesh for mesh in scene.geometry.values() if isinstance(mesh, trimesh.Trimesh)]
    if (not meshes or sum(len(mesh.faces) for mesh in meshes) > 250_000
            or sum(len(mesh.vertices) for mesh in meshes) > 500_000
            or sum(1 for _ in scene.graph.nodes_geometry) > 256):
        raise ValueError('Use a mesh with at most 250,000 faces and 256 instances')
    if any(not np.isfinite(mesh.vertices).all() for mesh in meshes):
        raise ValueError('Mesh coordinates must be finite')
    xyzrgb = glb_to_xyzrgb(str(glb), 'voxelized', resolution, output.parent).read_text()
    coords, colors = _parse_xyzrgb(xyzrgb)
    if not len(coords):
        raise ValueError('Mesh produced no voxels')
    coords -= coords.min(axis=0)
    if coords.max() > 255:
        raise ValueError('Voxel grid is too large')
    if output.suffix == '.vox':
        write_vox_from_xyzrgb(str(output), xyzrgb)
    elif output.suffix == '.qb':
        write_qb(output, coords, colors)
    elif output.suffix == '.binvox':
        write_binvox(output, coords)
    else:
        output.write_text(xyzrgb)


if __name__ == '__main__':
    # Isolate untrusted mesh parsing and bound memory on the Linux production host.
    if sys.platform == 'linux':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    try:
        convert_mesh(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]))
    except Exception:
        # Do not return parser exceptions or server file paths to the caller.
        sys.exit(2)
