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
  return `/pets/${id}-${state === 'listening' ? 'idle' : state}.mp4`;
}
