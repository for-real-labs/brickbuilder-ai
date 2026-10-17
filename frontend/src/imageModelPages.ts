export const IMAGE_MODEL_PAGES = [
  {
    path: '/image-to-3d', output: '3d', name: 'Image to 3D Converter',
    title: 'Image to 3D Converter | AI 3D Model from a Photo | BrickBuilder AI',
    description: 'Turn an image into a 3D model with AI. Upload a photo, preview the generated mesh, and download a GLB or OBJ file. Explore LEGO designs from your image too.',
    intro: 'Give your image a new dimension. Upload a photo or illustration, generate a 3D model with AI, and download it as GLB or OBJ.',
    heading: 'Turn a single image into a 3D model',
    body: 'Image-to-3D generation estimates a three-dimensional shape from a flat picture. Start with a clear photo of one object, a product image, or an illustration. The AI infers depth and unseen surfaces, so the result is an interpretation rather than an exact scan or a dimensionally accurate CAD model.',
    use: 'Use the GLB download for a compact model with its generated appearance, or export OBJ geometry for a mesh-editing workflow. Inspect the model from every angle before using it in another project.',
  },
  {
    path: '/image-to-glb', output: 'glb', name: 'Image to GLB Converter',
    title: 'Image to GLB Converter | Photo to GLB 3D Model | BrickBuilder AI',
    description: 'Convert an image to a GLB 3D model with AI. Upload a photo or illustration, preview the result, and download a binary glTF file for your 3D workflow.',
    intro: 'Turn your photo or illustration into a downloadable GLB model. Generate a 3D shape from your image and inspect it in your browser.',
    heading: 'Convert a photo into a binary glTF model',
    body: 'GLB is the binary form of glTF, a format that packages mesh geometry and materials into one file. This image-to-GLB converter first creates a 3D interpretation of your picture, then gives you the original generated GLB. It does more than change an image filename: the AI estimates the object’s shape and appearance.',
    use: 'Import the GLB into software that supports binary glTF, or use it as a starting point for a LEGO-compatible design. The generated file is a static model; it is not a rigged or animated character, and fine details may need cleanup in a 3D editor.',
  },
  {
    path: '/image-to-obj', output: 'obj', name: 'Image to OBJ Converter',
    title: 'Image to OBJ Converter | Photo to Wavefront OBJ | BrickBuilder AI',
    description: 'Convert an image to a Wavefront OBJ mesh with AI. Generate a 3D model from your photo, preview it, and download OBJ geometry for editing or LEGO design.',
    intro: 'Create a Wavefront OBJ mesh from a photo or illustration. Generate your model with AI, preview it in 3D, and export its geometry for editing.',
    heading: 'Create editable OBJ geometry from an image',
    body: 'Wavefront OBJ is a widely supported text format for polygon mesh geometry. The image-to-OBJ workflow generates a GLB model from your picture, then exports its static mesh as an OBJ file. Use it as a starting point in a modeling or sculpting tool that accepts OBJ imports.',
    use: 'The OBJ download contains geometry. It does not include an MTL file, texture images, rigging, or animation. Choose the GLB download if you need the generated materials and textures. Check scale, topology, and mesh quality in your editor before using the result for manufacturing or printing.',
  },
] as const;

export type ImageModelOutput = typeof IMAGE_MODEL_PAGES[number]['output'];

export function imageModelFaqs(output: ImageModelOutput) {
  const label = output === '3d' ? '3D' : output.toUpperCase();
  return [
    { question: `How do I convert an image to ${label}?`, answer: `Choose an image, select Generate 3D model, and wait for processing to finish. Rotate the preview to inspect the result, then download ${output === 'obj' ? 'OBJ geometry or the original GLB' : 'the GLB model or export OBJ geometry'}. The same generation can supply both formats without generating again.` },
    { question: 'Which image formats can I upload?', answer: 'Upload a JPG, PNG, WebP, GIF, HEIC, HEIF, or TIFF image up to 50 MB. Some formats are converted in your browser before upload. A clear picture of one object with good lighting and a simple background usually gives the AI a clearer starting point.' },
    { question: 'Does this generate the original object or a LEGO model?', answer: 'The downloadable mesh is an AI interpretation of your original image. This tool skips the LEGO-style image preprocessing. The existing generation pipeline also prepares a brick version, which you can open from the result. Use image to LEGO for a dedicated brick-design workflow.' },
    { question: 'Is image-to-3D generation free?', answer: 'Generation uses the same credits and guest limits as the existing image-generation tools. If your guest allowance or credits run out, you will need to sign in or add credits. Exporting the completed model to another format does not start another AI generation.' },
    { question: 'Will the model match every side of my photo?', answer: 'A single image cannot show every surface. AI estimates hidden sides, depth, and small details, so results may differ from the original object. This is not an exact 3D scan, a CAD reconstruction, or a guarantee of a print-ready mesh.' },
    { question: 'What is the difference between GLB and OBJ downloads?', answer: 'GLB keeps the generated mesh and bundled appearance in one binary glTF file. The OBJ export contains static polygon geometry without MTL materials, textures, rigging, or animation. Choose GLB for appearance and OBJ for geometry-focused editing.' },
  ];
}
