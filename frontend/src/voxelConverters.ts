export type MeshFormat = 'glb' | 'obj';

export const VOXEL_FORMATS = {
  vox: {
    name: 'VOX', fullName: 'MagicaVoxel VOX', colors: 'Up to 255 palette colors',
    description: 'Create a colored .vox model for MagicaVoxel and voxel editors that support VOX. Mesh surfaces become a voxel grid with a palette of up to 255 colors.',
    use: 'Choose VOX to edit your converted model in MagicaVoxel. The download contains one voxel model and its color palette, ready for voxel sculpting and scene building.',
    limitation: 'VOX uses a limited palette, so models with more than 255 sampled colors are reduced to the most frequent colors and their nearest matches. Meshes are flattened into a single voxel model; animation and scene hierarchy are not retained.',
  },
  qb: {
    name: 'QB', fullName: 'Qubicle Binary', colors: 'RGB colors',
    description: 'Create a colored Qubicle Binary .qb file from your mesh. The converter writes one uncompressed RGBA voxel matrix for Qubicle and tools that import QB.',
    use: 'Choose QB for a Qubicle workflow or a game asset pipeline that accepts Qubicle Binary. Each occupied voxel keeps its sampled RGB color without a 255-color palette limit.',
    limitation: 'The download is a single uncompressed matrix. Separate mesh objects, animation, material settings, and transparency are not preserved. Check that your destination tool accepts the QB interchange format.',
  },
  binvox: {
    name: 'BINVOX', fullName: 'BINVOX occupancy grid', colors: 'Occupancy only; no colors',
    description: 'Create a .binvox occupancy grid from your 3D mesh. Download a run-length encoded binary voxel grid for geometry processing and voxel research workflows.',
    use: 'Choose BINVOX when you need a cubic grid of occupied and empty cells for shape analysis, scripts, or a pipeline that reads BINVOX version 1.',
    limitation: 'BINVOX version 1 stores occupancy only, so colors and textures are discarded. Its header uses normalized grid coordinates, not the original model’s physical units.',
  },
  xyzrgb: {
    name: 'XYZRGB', fullName: 'XYZRGB voxel coordinates', colors: 'RGB colors',
    description: 'Create a plain-text .xyzrgb list of colored voxel coordinates. Each row contains integer x y z positions followed by red, green, and blue values from 0 to 255.',
    use: 'Choose XYZRGB to inspect, script, or process a sparse colored voxel grid. Only occupied cells are listed, making it easy to read in Python or another data pipeline.',
    limitation: 'XYZRGB is a simple text convention rather than a full voxel editor project. It does not include a scene, animation, voxel pitch, or source units. Your importer must expect six space-separated values per row.',
  },
} as const;

export type VoxelFormat = keyof typeof VOXEL_FORMATS;
export const VOXEL_CONVERTERS = (['glb', 'obj'] as const).flatMap(input =>
  (Object.keys(VOXEL_FORMATS) as VoxelFormat[]).map(output => ({
    input: input as MeshFormat, output, path: `/${input}-to-${output}`,
  })),
);
