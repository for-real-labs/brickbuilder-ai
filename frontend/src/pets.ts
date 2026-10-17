export const PETS = [
  { id: 'pip', name: 'Pip', title: 'The little brick buddy', description: 'A curious little helper. Always ready to snap your next idea together.' },
  { id: 'nib', name: 'Nib', title: 'The pocket builder', description: 'A clever, slightly mischievous beaver with a soft spot for big builds.' },
  { id: 'clik', name: 'Clik', title: 'The imagination dragon', description: 'A gentle little dragon who collects bricks and dreams up adventures.' },
] as const;

export type PetId = typeof PETS[number]['id'];
export type PetState = 'idle' | 'listening' | 'building' | 'celebrating';
export const PET_STORAGE_KEY = 'brickbuilder.pet';
export const PET_MOTION_KEY = 'brickbuilder.petMotion';

export function isPetId(value: unknown): value is PetId {
  return PETS.some(pet => pet.id === value);
}

export function petVideoPath(id: PetId, state: PetState) {
  const clip = state === 'listening' ? 'idle' : state;
  return `/pets/loops-v2/${id}-${clip}-alpha.webm`;
}

export function petVideoSources(id: PetId, state: PetState) {
  const webm = petVideoPath(id, state);
  return [
    // Safari supports QuickTime HEVC alpha. Chromium skips this MIME type,
    // avoiding its HEVC decoder, which can play the color layer without alpha.
    { src: webm.replace(/\.webm$/, '.mov'), type: 'video/quicktime; codecs="hvc1"' },
    { src: webm, type: 'video/webm; codecs="vp9"' },
  ];
}
