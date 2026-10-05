// Short, curated build ideas: recognizable subjects mixed with scenes and designs.
export const PROMPT_EXAMPLES: readonly string[] = [
  // Nintendo and video games
  'Mario', 'Luigi', 'Princess Peach', 'Bowser', 'Yoshi', 'Toad',
  'Donkey Kong', 'Kirby', 'Link', 'Zelda', 'Samus', 'Isabelle',
  'Tom Nook', 'a Mario Kart', 'Peach’s castle', 'a Super Mario pipe',
  'a Nintendo Switch', 'a Game Boy', 'Kirby eating cake', 'Yoshi’s egg',
  'Sonic the Hedgehog', 'Tails', 'Knuckles', 'Pac-Man',
  'a Minecraft Creeper', 'a Minecraft village', 'a Tetris tower',
  'a Portal companion cube', 'Master Chief', 'a Halo Warthog',

  // Pokémon
  'Pikachu', 'Charizard', 'Bulbasaur', 'Squirtle', 'Eevee', 'Snorlax',
  'Gengar', 'Mewtwo', 'Jigglypuff', 'Psyduck', 'Magikarp', 'Lapras',
  'Dragonite', 'Lucario', 'a Poké Ball', 'a Pokémon Center',
  'sleeping Snorlax', 'surfing Pikachu', 'Eevee’s treehouse',
  'Charizard breathing fire',

  // Star Wars
  'Darth Vader', 'Yoda', 'Grogu', 'R2-D2', 'C-3PO', 'BB-8',
  'Chewbacca', 'Boba Fett', 'a stormtrooper', 'the Millennium Falcon',
  'an X-wing', 'a TIE fighter', 'the Death Star', 'an AT-AT',
  'Luke’s lightsaber', 'Jabba the Hutt', 'a podracer',
  'R2-D2 serving coffee', 'an Ewok village', 'a tiny Mos Eisley cantina',

  // Movies, comics, and animation
  'Spider-Man', 'Batman', 'Superman', 'Wonder Woman', 'Iron Man',
  'Captain America’s shield', 'the Batmobile', 'Gotham City',
  'Hogwarts', 'Harry Potter', 'Dobby', 'Totoro', 'Godzilla',
  'King Kong', 'Shrek', 'SpongeBob', 'Snoopy', 'Garfield',
  'Hello Kitty', 'Stitch', 'WALL-E', 'Buzz Lightyear', 'Woody',
  'Elsa’s ice castle', 'a Minion', 'the Up house', 'Scooby-Doo’s van',
  'a Ghostbusters firehouse', 'the Jurassic Park gate',

  // Celebrities and musicians
  'Taylor Swift', 'Beyoncé', 'Lady Gaga', 'Billie Eilish', 'Dolly Parton',
  'Elvis Presley', 'Freddie Mercury', 'Snoop Dogg', 'Bad Bunny',
  'Harry Styles', 'Rihanna', 'Michael Jackson', 'Elton John',
  'Lionel Messi', 'Cristiano Ronaldo', 'Serena Williams',
  'Michael Jordan', 'LeBron James', 'Simone Biles', 'Gordon Ramsay',
  'Taylor Swift on stage', 'Elvis’s pink Cadillac', 'Messi scoring a goal',
  'Freddie Mercury at a piano', 'Dolly Parton’s guitar',

  // Locations and landmarks
  'the Eiffel Tower', 'the Statue of Liberty', 'Big Ben', 'the Taj Mahal',
  'the Sydney Opera House', 'the Colosseum', 'the Golden Gate Bridge',
  'the Empire State Building', 'the Burj Khalifa', 'the Space Needle',
  'the Leaning Tower of Pisa', 'the Great Wall of China', 'Mount Fuji',
  'Mount Rushmore', 'the pyramids of Giza', 'Stonehenge',
  'the White House', 'the Louvre pyramid', 'the Sagrada Família',
  'Chichen Itza', 'a Venice canal', 'a Tokyo street', 'a New York skyline',
  'a Santorini village', 'a London phone booth', 'a Chicago skyline',
  'a Paris café', 'a Kyoto temple', 'a Miami lifeguard tower',
  'a San Francisco cable car',

  // Cars and other vehicles
  'a Porsche 911', 'a Ferrari F40', 'a Lamborghini Countach',
  'a Tesla Cybertruck', 'a Ford Mustang', 'a Chevrolet Corvette',
  'a Volkswagen Beetle', 'a Volkswagen camper van', 'a Mini Cooper',
  'a Jeep Wrangler', 'a Nissan Skyline', 'a Toyota Supra',
  'a Mazda MX-5', 'a Dodge Challenger', 'a BMW M3',
  'a Mercedes G-Wagon', 'a Bugatti Chiron', 'a McLaren P1',
  'a DeLorean time machine', 'a yellow school bus', 'a red double-decker bus',
  'a Vespa scooter', 'a Harley-Davidson motorcycle', 'a Concorde',
  'a Ferrari pit stop', 'a monster truck jump', 'a pink Porsche',
  'a tiny car dealership', 'a Formula 1 starting grid', 'a vintage gas station',

  // Business logos, products, and storefronts
  'the Nike swoosh', 'the Apple logo', 'the McDonald’s golden arches',
  'the Starbucks logo', 'the Adidas logo', 'the Google logo',
  'the YouTube logo', 'the Spotify logo', 'the Netflix logo',
  'the Target logo', 'the Pepsi logo', 'the Coca-Cola logo',
  'the Shell logo', 'the Batman symbol', 'the Superman symbol',
  'a Coca-Cola vending machine', 'a McDonald’s restaurant',
  'a Starbucks café', 'an Apple Store', 'an IKEA store',
  'a Nike sneaker', 'an Oreo cookie', 'a Campbell’s soup can',
  'a Heinz ketchup bottle', 'a Pringles can',

  // Simple objects and playful scenes
  'a unicorn', 'a dragon', 'a red panda', 'a rubber duck', 'a cactus',
  'a sunflower', 'a croissant', 'a birthday cake', 'a sushi platter',
  'a grand piano', 'a lighthouse', 'a treehouse', 'a medieval castle',
  'a rocket launch', 'a moon landing', 'a pirate ship', 'a treasure chest',
  'a disco ball', 'a roller coaster', 'a tiny bookstore',
  'a dachshund in sunglasses', 'a robot making pizza',
  'a penguin ice cream shop', 'a floating island', 'a mushroom village',
];

export function pickPromptExampleIndex(previousIndex = -1): number {
  if (previousIndex < 0) return Math.floor(Math.random() * PROMPT_EXAMPLES.length);
  const index = Math.floor(Math.random() * (PROMPT_EXAMPLES.length - 1));
  return index >= previousIndex ? index + 1 : index;
}
