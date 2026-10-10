export const IMAGE_LANDING_PAGES = {
  'image-to-lego': {
    title: 'Image to LEGO Converter — BrickBuilder AI',
    description: 'Turn an image into a 3D LEGO-compatible brick model. Upload artwork, a drawing or an image, add optional instructions, and preview your build with building instructions.',
    uploadTitle: 'Turn your image into LEGO',
    uploadDescription: 'Upload artwork, a drawing or any image to create a buildable brick model.',
    keywords: 'image to lego, image to lego converter, turn image into lego, picture to lego, AI lego builder',
  },
  'use-ai-to-edit-ldraw': {
    title: 'Use AI to Edit LDraw & Studio Models — BrickBuilder AI',
    description: 'Upload a Studio .io, LDraw .ldr or MPD model and edit it with AI. Preview your build, describe your changes, and adapt it to available Brickwith parts and colors.',
    uploadTitle: 'Use AI to edit your LDraw model',
    uploadDescription: 'Bring your Studio or LDraw model. Describe the changes and let AI edit your build.',
    keywords: 'use ai to edit ldraw, AI LDraw editor, edit Studio io with AI, LDR editor, MPD editor, upload LDraw, BrickLink Studio AI',
  },
  'photo-to-lego': {
    title: 'Photo to LEGO Converter — BrickBuilder AI',
    description: 'Turn a photo into a 3D LEGO-compatible brick model. Upload a photo from your phone or computer, including iPhone HEIC photos, and get a model with building instructions.',
    uploadTitle: 'Turn your photo into LEGO',
    uploadDescription: 'Upload a photo from your phone or computer, including iPhone HEIC photos.',
    keywords: 'photo to lego, photo to lego converter, turn photo into lego, iPhone photo to lego, HEIC to lego',
  },
} as const;
export type ImageLandingPath = keyof typeof IMAGE_LANDING_PAGES;
