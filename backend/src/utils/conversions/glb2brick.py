#!/usr/bin/env python3

import sys
import argparse
import numpy as np
import open3d as o3d
from pathlib import Path
from typing import Tuple, Dict, Any, List
from scipy.spatial import cKDTree
from scipy.ndimage import distance_transform_edt

from .voxel2brick import voxel2brick
from .voxel_utils import fill_interior_voxels, detect_thin_regions, save_voxel_array_to_xyzrgb
from ..color_conversions import color_array_to_ldr_colors, convert_xyzrgb_to_ldr_colors


# Target brick count constraints for auto-adjustment
# Set MAX_VOXEL_ADJUSTMENT_ITERATIONS to 0 or 1 to disable auto-adjustment
TARGET_BRICK_COUNT_MIN = 300
TARGET_BRICK_COUNT_MAX = 400
MAX_VOXEL_ADJUSTMENT_ITERATIONS = 0  # Set to 0 or 1 to disable


def load_xyzrgb_to_voxel_array(xyzrgb_path: str) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """
    Load a .xyzrgb file and convert to voxel array format.
    
    Args:
        xyzrgb_path: Path to the .xyzrgb file
        
    Returns:
        voxel_array: 3D boolean array
        color_array: 3D RGB array with colors for each voxel
        metadata: Processing information
    """
    print(f"📂 Loading voxel data from: {xyzrgb_path}")
    
    # Load the XYZRGB data
    data = np.loadtxt(xyzrgb_path, ndmin=2)
    
    # Extract coordinates and colors
    coords = data[:, :3].astype(int)  # X, Y, Z coordinates
    colors = data[:, 3:6] / 255.0  # RGB colors (normalize to 0-1)
    
    # Determine grid dimensions
    min_coords = coords.min(axis=0)
    max_coords = coords.max(axis=0)
    grid_dims = max_coords - min_coords + 1
    
    print(f"  📊 Loaded {len(coords)} voxels")
    print(f"  📦 Grid dimensions: {grid_dims}")
    print(f"  📍 Min coords: {min_coords}")
    print(f"  📍 Max coords: {max_coords}")
    
    # Create arrays
    voxel_array = np.zeros(grid_dims, dtype=bool)
    color_array = np.zeros((*grid_dims, 3))
    
    # Populate arrays (shift coordinates to start at 0)
    shifted_coords = coords - min_coords
    for i, (x, y, z) in enumerate(shifted_coords):
        voxel_array[x, y, z] = True
        color_array[x, y, z] = colors[i]
    
    # Create metadata
    unique_colors = len(np.unique(colors, axis=0))
    metadata = {
        'original_file': xyzrgb_path,
        'voxel_size': 1.0,  # Assume unit voxel size
        'grid_dimensions': grid_dims,
        'grid_origin': min_coords,
        'total_voxels': len(coords),
        'unique_colors': unique_colors,
        'coordinate_fix_applied': False
    }
    
    print(f"  ✅ Conversion complete:")
    print(f"    Grid shape: {voxel_array.shape}")
    print(f"    Occupied voxels: {voxel_array.sum()}")
    print(f"    Unique colors: {unique_colors}")
    
    return voxel_array, color_array, metadata


def glb2xyzrgb(glb_path: str, voxel_size: float = 32, voxelizer: str = "trimesh") -> Dict[str, Any]:
    """
    First half of the pipeline: GLB -> voxelization -> xyzrgb file.

    Returns immediately once the xyzrgb content is ready, without running
    brick optimization or LDR generation.

    Args:
        glb_path: Path to input GLB file
        voxel_size: Resolution for voxelization (default: 32)
        voxelizer: Which voxelizer to use, "trimesh" (default) or "obj2voxel"
            (the legacy GLB -> OBJ -> C++ obj2voxel path)

    Returns:
        Dictionary with:
        - xyzrgb_file: Path to the generated xyzrgb file
        - xyzrgb_content: The xyzrgb file contents as a string
        - input_stem: The stem of the input file (needed by glb2brick)
    """
    voxelizer = (voxelizer or "trimesh").lower()
    if voxelizer not in ("trimesh", "obj2voxel"):
        raise ValueError(f"Unknown voxelizer '{voxelizer}'. Use 'trimesh' or 'obj2voxel'.")

    print(f"🚀 Starting GLB->XYZRGB pipeline for: {glb_path} (voxelizer={voxelizer})")

    input_stem = Path(glb_path).stem
    obj2vox_build_dir = Path("tmp")
    obj2vox_build_dir.mkdir(parents=True, exist_ok=True)

    from .trimesh_voxelizer import write_vox_from_xyzrgb

    if voxelizer == "obj2voxel":
        # Legacy path: GLB -> OBJ (+texture) -> C++ obj2voxel -> xyzrgb.
        print(f"\n📝 Step 1: Converting GLB to OBJ...")
        from .glb2obj import glb_to_obj
        obj_path, mtl_path, texture_path = glb_to_obj(glb_path)

        from .obj2voxel import obj_to_voxel
        xyzrgb_build_path = obj_to_voxel(obj_path, mtl_path, texture_path, input_stem, voxel_size)

        # Clean up OBJ/MTL/texture intermediates.
        files_to_delete = [
            obj2vox_build_dir / Path(obj_path).name,
            obj2vox_build_dir / "material.mtl",
            Path(obj_path),
            Path(mtl_path) if mtl_path else None,
            Path(texture_path) if texture_path else None,
        ]
        # Remove every copied texture (material_0.png, material_1.png, ...) from
        # both the build dir and the source dir.
        for texture_dir in {obj2vox_build_dir, Path(obj_path).parent}:
            files_to_delete.extend(texture_dir.glob("material_*.png"))
        for file_path in files_to_delete:
            if file_path and file_path.exists():
                file_path.unlink()
                print(f"  🗑️  Deleted: {file_path}")
    else:
        # Default path: voxelize the GLB directly with trimesh (color-preserving).
        from .trimesh_voxelizer import glb_to_xyzrgb
        xyzrgb_build_path = glb_to_xyzrgb(glb_path, input_stem, voxel_size, obj2vox_build_dir)

    # Step 2: Convert xyzrgb colors to the LDR palette.
    print(f"\n🔄 Step 2: Mapping voxel colors to LDR palette...")
    xyzrgb_path = str(xyzrgb_build_path)

    with open(xyzrgb_path, 'r') as f:
        original_xyzrgb_content = f.read()
    converted_xyzrgb_content = convert_xyzrgb_to_ldr_colors(original_xyzrgb_content)
    with open(xyzrgb_path, 'w') as f:
        f.write(converted_xyzrgb_content)
    print(f"  💾 Saved LDR-colored XYZRGB file: {xyzrgb_path}")

    # Step 3: Emit the secondary .vox artifact (used by storage uploads).
    vox_path = str(obj2vox_build_dir / f"{input_stem}.vox")
    write_vox_from_xyzrgb(vox_path, converted_xyzrgb_content)

    return {
        'xyzrgb_file': xyzrgb_path,
        'xyzrgb_content': converted_xyzrgb_content,
        'input_stem': input_stem,
    }


def glb2brick(glb_path: str, world_size: float = 25.0, voxel_size: float = 32, xyzrgb_path: str = None, auto_adjust_brick_count: bool = True, voxelizer: str = "trimesh") -> Dict[str, Any]:
    """
    Complete pipeline: GLB -> PLY -> voxel array -> optimized bricks.
    
    If auto_adjust_brick_count=True and MAX_VOXEL_ADJUSTMENT_ITERATIONS > 1, 
    will automatically adjust voxel size to achieve a brick count between 
    TARGET_BRICK_COUNT_MIN and TARGET_BRICK_COUNT_MAX.
    
    Args:
        glb_path: Path to input GLB file
        world_size: World size for processing (default: 25.0)
        voxel_size: Resolution for voxelization (default: 32)
        xyzrgb_path: Optional path to existing .xyzrgb file to skip GLB->voxel conversion
        auto_adjust_brick_count: Whether to auto-adjust voxel size to hit target brick count (default: True)
        voxelizer: Which voxelizer to use, "trimesh" (default) or "obj2voxel"
    
    Returns:
        Dictionary with processing information
    """
    print(f"🚀 Starting full pipeline for: {glb_path}")
    
    input_stem = Path(glb_path).stem
    obj2vox_build_dir = Path("tmp")
    obj2vox_build_dir.mkdir(parents=True, exist_ok=True)
    
    # Determine if we should run brick count adjustment
    should_adjust = auto_adjust_brick_count and MAX_VOXEL_ADJUSTMENT_ITERATIONS > 1
    
    iteration = 0
    while True:
        iteration += 1
        if should_adjust:
            print(f"\n🔄 Iteration {iteration}/{MAX_VOXEL_ADJUSTMENT_ITERATIONS} (voxel_size={voxel_size})")
        
        # If xyzrgb_path is provided on the first iteration, skip GLB->OBJ->voxel conversion
        if xyzrgb_path is not None and iteration == 1:
            print(f"\n⏩ Skipping GLB->OBJ->voxel conversion, loading from existing XYZRGB file...")
            voxel_array, color_array, metadata = load_xyzrgb_to_voxel_array(xyzrgb_path)
        else:
            # Run GLB -> voxel -> LDR-color conversion via glb2xyzrgb
            xyzrgb_info = glb2xyzrgb(glb_path, voxel_size=voxel_size, voxelizer=voxelizer)
            xyzrgb_path = xyzrgb_info['xyzrgb_file']
            voxel_array, color_array, metadata = load_xyzrgb_to_voxel_array(xyzrgb_path)
        
        print(f"  ✅ Loaded voxel data from XYZRGB file")
        
        # Fill interior voxels with configurable shell thickness, adds more bricks for stability
        shell_thickness = 2
        print(f"\n🎨 Step 4: Filling interior voxels (shell thickness: {shell_thickness})...")
        voxel_array, color_array, surface_mask = fill_interior_voxels(voxel_array, color_array, shell_thickness)
        
        # Convert RGB colors to LDR color codes
        ldr_color_array = color_array_to_ldr_colors(voxel_array, color_array)
        
        # Run voxel2brick optimization
        print(f"\n🧱 Running voxel2brick optimization...")
        print(f"  Processing {voxel_array.sum()} voxels...")
        if voxel2brick is None:
            raise RuntimeError("voxel2brick is not available. Cannot run optimization.")
        
        brick_structure = voxel2brick(
            voxel_array, 
            color_array=ldr_color_array,
            surface_mask=surface_mask,
            run_stability_passes=False,
            use_color_constraints=True,
            hard_constraints=True,
            wc=1000.0,
            max_failures=100, 
            seed=42
        )
        
        brick_count = len(brick_structure.bricks)
        print(f"✅ Created optimized brick structure with {brick_count} bricks")
        
        # Check if brick count is within target range (only if auto-adjustment is enabled)
        if should_adjust:
            print(f"  📊 Brick count: {brick_count} (target: {TARGET_BRICK_COUNT_MIN}-{TARGET_BRICK_COUNT_MAX})")
            
            if TARGET_BRICK_COUNT_MIN <= brick_count <= TARGET_BRICK_COUNT_MAX:
                print(f"  ✅ Brick count is within target range!")
                break
            
            if iteration >= MAX_VOXEL_ADJUSTMENT_ITERATIONS:
                print(f"  ⚠️  Max iterations reached. Proceeding with current result.")
                break
            
            # Adjust voxel size for next iteration
            if brick_count < TARGET_BRICK_COUNT_MIN:
                voxel_size = int(voxel_size * 1.15)  # Increase by 15%
                print(f"  ⬆️  Too few bricks, increasing voxel_size to {voxel_size}")
            else:
                voxel_size = int(voxel_size * 0.85)  # Decrease by 15%
                print(f"  ⬇️  Too many bricks, decreasing voxel_size to {voxel_size}")
            
            # Reset xyzrgb_path so we re-run voxelization
            xyzrgb_path = None
            continue
        
        # No auto-adjustment, exit loop
        break
    
    # Check for floating bricks after optimization
    if brick_structure.has_floating_bricks():
        floating_bricks = [brick for brick in brick_structure.bricks if brick_structure.brick_floats(brick)]
        floating_count = len(floating_bricks)
        print(f"⚠️  Warning: {floating_count} floating bricks detected after voxel2brick optimization")
        if floating_count > 5:

            # Add shell thickness for stability
            shell_thickness = 3
            print(f"\n🎨 Adding shell thickness: {shell_thickness})...")
            voxel_array, color_array, surface_mask = fill_interior_voxels(voxel_array, color_array, shell_thickness)
            
            # Regenerate LDR color array after filling interior voxels
            ldr_color_array = color_array_to_ldr_colors(voxel_array, color_array)
            
            print(f"⚠️  Rerunning voxelization with shell thickness to reduce floating bricks...")
            brick_structure = voxel2brick(
                voxel_array, 
                color_array=ldr_color_array,
                surface_mask=surface_mask,
                run_stability_passes=False,
                use_color_constraints=True,
                hard_constraints=True,
                wc=1000.0,
                max_failures=100, 
                seed=42
            )
            if brick_structure.has_floating_bricks():
                floating_bricks = [brick for brick in brick_structure.bricks if brick_structure.brick_floats(brick)]
                floating_count = len(floating_bricks)
                print(f"⚠️  Warning: {floating_count} floating bricks detected after shell thickness added")
            else:
                print(f"✅ No floating bricks detected after shell thickness added")
    else:
        print(f"✅ No floating bricks detected after optimization")
    
    # Save as LDR file (to_ldr() handles floating brick removal internally)
    # Write into the same directory as the input GLB so it lands in the temp dir
    ldr_output = str(Path(glb_path).parent / f"{input_stem}.ldr")
    with open(ldr_output, 'w') as f:
        f.write(brick_structure.to_ldr())
    print(f"  💾 Saved LDR file: {ldr_output}")
    
    # Save problematic voxels to xyzrgb file (positions only, no colors needed)
    # Save locally for testing (in current directory)
    problematic_xyzrgb_filename = f"{input_stem}_problematic.xyzrgb"
    problematic_xyzrgb_path = str(obj2vox_build_dir / problematic_xyzrgb_filename)
    if brick_structure.problematic_voxels:
        # Get grid_origin to convert back to original world coordinates
        grid_origin = metadata.get('grid_origin', np.array([0, 0, 0]))
        with open(problematic_xyzrgb_path, 'w') as f:
            for x, y, z in brick_structure.problematic_voxels:
                # Add grid_origin offset to convert from array coords back to world coords
                world_x = x + grid_origin[0]
                world_y = y + grid_origin[1]
                world_z = z + grid_origin[2]
                # Write as xyzrgb format with placeholder color (255, 0, 0 = red for visibility)
                f.write(f"{world_x} {world_y} {world_z} 255 0 0\n")
        print(f"  💾 Saved {len(brick_structure.problematic_voxels)} problematic voxels: {problematic_xyzrgb_path}")
    else:
        problematic_xyzrgb_path = None
        print(f"  ✅ No problematic voxels to save")
    
    # Clean up temporary files
    # Note: OBJ/MTL/texture files are already cleaned up by glb2xyzrgb
    print(f"\n🧹 Cleaning up temporary files...")
    
    # XYZRGB files in build directory - keep for storage upload
    xyzrgb_filename = f"{input_stem}.xyzrgb"
    xyzrgb_file_path = str(obj2vox_build_dir / xyzrgb_filename)
    
    # VOX file should be created alongside XYZRGB by obj2voxel
    vox_filename = f"{input_stem}.vox"
    vox_path = str(obj2vox_build_dir / vox_filename)

    # Create summary
    info = {
        'input_file': glb_path,
        'ldr_file': ldr_output,
        'vox_file': vox_path,
        'xyzrgb_file': xyzrgb_file_path,
        'problematic_xyzrgb_file': problematic_xyzrgb_path,
        'brick_count': len(brick_structure.bricks),
        'processing_steps': [
            'GLB -> XYZRGB voxelization (trimesh)',
            'XYZRGB -> Voxel Array', 
            'Voxel Array -> Optimized Bricks',
            'Optimized Bricks -> Colored Visualization'
        ],
        'unique_colors': metadata['unique_colors'],
        'grid_dimensions': metadata['grid_dimensions'].tolist() if isinstance(metadata['grid_dimensions'], np.ndarray) else list(metadata['grid_dimensions']),
        'voxel_size': voxel_size,
        'world_size': world_size,
        'bypass_mode': False,
        'source_xyzrgb': xyzrgb_path,
    }
    
    return info


def main():
    parser = argparse.ArgumentParser(description="GLB to LEGO Brick Conversion")
    parser.add_argument("input", help="Input GLB file")
    parser.add_argument("--world-size", type=float, default=25.0, 
                        help="World size for GLB processing (default: 25.0)")
    parser.add_argument("--voxel-size", type=float, default=32, 
                        help="Voxel resolution (default: 32)")
    parser.add_argument("--xyzrgb", type=str, default=None,
                        help="Optional path to existing .xyzrgb file to skip GLB->OBJ->voxel conversion")
    
    args = parser.parse_args()
    
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"❌ Error: Input file '{args.input}' not found!")
        return 1
    
    # Validate xyzrgb path if provided
    if args.xyzrgb is not None:
        xyzrgb_file = Path(args.xyzrgb)
        if not xyzrgb_file.exists():
            print(f"❌ Error: XYZRGB file '{args.xyzrgb}' not found!")
            return 1
    
    try:
        # Full pipeline
        if input_path.suffix.lower() not in ['.glb', '.gltf']:
            print(f"❌ Error: Full pipeline requires GLB/GLTF input")
            return 1
        
        # Use the full colored pipeline
        info = glb2brick(
            str(input_path),
            world_size=args.world_size,
            voxel_size=args.voxel_size,
            xyzrgb_path=args.xyzrgb,
        )
        
        print(f"\n🎉 Pipeline completed successfully!")
        print(f"📁 VOX file: {info['vox_file']}")
        print(f"📁 LDR file: {info['ldr_file']}")
        
        return 0
            
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit(main())
