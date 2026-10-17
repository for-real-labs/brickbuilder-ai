"""Read standalone mesh uploads without resolving user-controlled file paths."""
from pathlib import Path


def obj_to_glb(source_path: str) -> str:
    import trimesh

    # Ignore mtllib/texture references: a standalone OBJ must never read server
    # files or fetch remote material URLs supplied by an untrusted upload.
    with open(source_path, "rb") as source:
        scene = trimesh.load(source, file_type="obj", force="scene",
                             resolver=None, skip_materials=True, process=False)
    if not any(isinstance(mesh, trimesh.Trimesh) and len(mesh.faces)
               for mesh in scene.geometry.values()):
        raise ValueError("OBJ file must contain a mesh with faces")
    target = str(Path(source_path).with_suffix(".glb"))
    Path(target).write_bytes(scene.export(file_type="glb"))
    return target
