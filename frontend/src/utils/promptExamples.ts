const originalExamples = [
  'a unicorn', 'a red fire hydrant', 'a 3-story lakeside cabin',
  'baby yoda with a scarf', 'a retro space rover', 'a dachshund in sunglasses',
];

const animals = [
  'a corgi', 'a golden retriever', 'a poodle', 'a husky', 'a beagle',
  'a tabby cat', 'a black cat', 'a rabbit', 'a hamster', 'a guinea pig',
  'a fox', 'a wolf', 'a red panda', 'a panda', 'a koala',
  'a sloth', 'a raccoon', 'a hedgehog', 'an otter', 'a beaver',
  'a penguin', 'an owl', 'a parrot', 'a flamingo', 'a duck',
  'a goose', 'a toucan', 'a chicken', 'a frog', 'a turtle',
  'a crocodile', 'a chameleon', 'a gecko', 'a squirrel', 'a mouse',
  'a bear', 'a tiger', 'a lion', 'an elephant', 'a giraffe',
];
const animalDetails = [
  'wearing a tiny astronaut helmet', 'in a cozy knitted sweater',
  'holding a giant ice cream cone', 'wearing a pirate hat',
  'with a backpack full of flowers', 'riding a skateboard',
  'wearing rainbow sunglasses', 'playing a tiny electric guitar',
  'with a superhero cape', 'sitting in a teacup',
];
const places = [
  'a treehouse', 'a lighthouse', 'a windmill', 'a medieval castle', 'a wizard tower',
  'a mountain cabin', 'a beach house', 'a tiny bakery', 'a coffee shop', 'a bookstore',
  'a flower shop', 'a train station', 'a clock tower', 'a greenhouse', 'a garden cottage',
  'a mushroom house', 'a space observatory', 'a fire station', 'a post office', 'a toy shop',
  'a library', 'a seaside hotel', 'a candy shop', 'a village inn', 'a watermill',
  'a snowy chalet', 'a forest lodge', 'a floating island house', 'a fairy cottage', 'a music studio',
];
const placeDetails = [
  'with a rooftop garden', 'with bright blue doors', 'with a winding stone path',
  'with a tiny fountain outside', 'covered in climbing ivy', 'with rainbow windows',
  'with a red tiled roof', 'with a miniature courtyard', 'decorated with string lights',
  'surrounded by cherry blossom trees',
];
const vehicles = [
  'a vintage pickup truck', 'a race car', 'a camper van', 'a double-decker bus', 'a fire truck',
  'an ice cream truck', 'a monster truck', 'a dune buggy', 'a rally car', 'a sports car',
  'a delivery van', 'a city bus', 'a food truck', 'a tow truck', 'a snowplow',
  'a garbage truck', 'a taxi', 'a hot rod', 'a roadster', 'a limousine',
  'a tractor', 'a cement mixer', 'a bulldozer', 'a dump truck', 'a forklift',
  'a steamroller', 'a street sweeper', 'a golf cart', 'a safari jeep', 'a moon buggy',
];
const vehicleDetails = [
  'in pastel pink and mint', 'with golden wheels', 'with lightning bolt decals',
  'with a tiny robot driver', 'with oversized tires', 'with a striped paint job',
  'with glowing blue headlights', 'in retro orange and cream',
  'with a roof full of luggage', 'with a friendly face on the front',
];

function combine(subjects: readonly string[], details: readonly string[]): string[] {
  return subjects.flatMap(subject => details.map(detail => `${subject} ${detail}`));
}

// 1,000 additional build ideas, assembled from curated, compatible combinations.
export const PROMPT_EXAMPLES: readonly string[] = [
  ...originalExamples,
  ...combine(animals, animalDetails),
  ...combine(places, placeDetails),
  ...combine(vehicles, vehicleDetails),
];

export function pickPromptExampleIndex(previousIndex = -1): number {
  if (previousIndex < 0) return Math.floor(Math.random() * PROMPT_EXAMPLES.length);
  const index = Math.floor(Math.random() * (PROMPT_EXAMPLES.length - 1));
  return index >= previousIndex ? index + 1 : index;
}
