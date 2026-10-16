export const PETS = [
  { id: 'pip', name: 'Pip', title: 'The little brick buddy', description: 'A curious little helper. Always ready to snap your next idea together.' },
  { id: 'nib', name: 'Nib', title: 'The pocket builder', description: 'A clever, slightly mischievous beaver with a soft spot for big builds.' },
  { id: 'clik', name: 'Clik', title: 'The imagination dragon', description: 'A gentle little dragon who collects bricks and dreams up adventures.' },
] as const;

export type PetId = typeof PETS[number]['id'];
export type PetState = 'idle' | 'listening' | 'building' | 'celebrating';
export const PET_STORAGE_KEY = 'brickbuilder.pet';
export const PET_MOTION_KEY = 'brickbuilder.petMotion';
export const PIP_TRANSPARENT_IDLE = '/pets/pip-idle-alpha.webm';

export function isPetId(value: unknown): value is PetId {
  return PETS.some(pet => pet.id === value);
}

export function petVideoPath(id: PetId, state: PetState) {
  const clip = state === 'listening' ? 'idle' : state;
  return id === 'pip' && clip === 'idle' ? PIP_TRANSPARENT_IDLE : `/pets/${id}-${clip}.mp4`;
}
