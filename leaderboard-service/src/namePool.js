// Mirrors index.html's reel word arrays and the (retired)
// waterpark-leaderboard/includes/class-name-pool.php byte-for-byte. There
// is still no build step tying these together — if the reel words or
// blocklist change on the client, they must change here too, or a
// legitimate reel pick will be rejected as invalid. See DATABASE.md's
// "Word pool" section for the audited history of this list.
const NAME_A = [
  "Salty", "Rowdy", "Soggy", "Rusty", "Lucky", "Wild", "Trusty", "Sandy",
  "Muddy", "Sunbaked", "Splashy", "Gritty", "Speedy", "Bouncy", "Rugged", "Breezy",
  "Sizzlin'", "Drippy", "Twisty", "Wobbly", "Hasty", "Jumpy", "Zippy", "Peppy", "Sunny",
  "Stormy", "Boomin'", "Rollin'", "Tumblin'", "Whistlin'", "Hollerin'", "Ramblin'",
  "Roamin'", "Frosty", "Dizzy", "Scrappy", "Plucky", "Nimble", "Sturdy", "Cheerful",
  "Scorchin'", "Blazing", "Weathered", "Sunkissed", "Windswept", "Sunburnt", "Barefoot",
  "Wiry", "Feisty", "Hardy", "Coastal", "Driftin'", "Cruisin'", "Glidin'",
  "Untamed", "Free-roamin'", "Shreddin'", "Whoopin'", "Barrelin'", "Laidback",
  "Rip-roarin'", "Beachbound", "Sun-drenched", "Tide-tossed", "Palm-shaded",
  "Surfside", "Curlin'", "Dune-hoppin'", "Crested", "Shorebound",
  "Tanned", "Splashin'", "Drenched", "Soaked", "Waterlogged", "Bubbly", "Foamy",
  "Fizzy", "Slick", "Sloshy", "Wavy", "Rippling", "Gushing", "Misty",
  "Dewy", "Damp", "Drizzly", "Poolside", "Tubular", "Slidin'", "Divin'",
  "Cannonballin'", "Floatin'", "Bobbin'", "Sudsy", "Frothy", "Sparkling", "Chilly",
  "Dripping",
];

const NAME_B = [
  "Surfboard", "Longboard", "Boogieboard", "Paddleboard", "Wetsuit", "Driftwood",
  "Palmtree", "Coconut", "Pineapple", "Hibiscus", "Seashell", "Sandbar", "Sanddollar",
  "Seagull", "Albatross", "Cormorant", "Sandpiper", "Osprey", "Reef", "Lagoon",
  "Cannonball", "Riptide", "Bellyflop", "Flume", "Geyser", "Gator", "Catfish", "Otter",
  "Pelican", "Dolphin", "Splashdown", "Whirlpool", "Ripcurl", "Sunfish", "Seahorse",
  "Bullfrog", "Turtle", "Minnow", "Anchor", "Torpedo",
  "Cove", "Atoll", "Undertow", "Swell", "Breaker", "Crest", "Foam",
  "Spray", "Mist", "Horizon", "Sunset", "Sunrise", "Boardwalk", "Cabana", "Tiki",
  "Hammock", "Flipflop", "Sunhat", "Beachcomber", "Lighthouse", "Bonfire", "Firepit", "Sandpit",
  "Palmshade", "Tradewind", "Monsoon", "Squall", "Barrel", "Pipeline", "Fin",
  "Campfire", "Lantern", "Current", "Bay", "Tidalwave", "Wavepool", "Lazyriver",
  "Waterslide", "Slipnslide", "Splashpad", "Kayak", "Jetski", "Lifeguard", "Snorkel",
  "Flipper", "Mermaid", "Narwhal", "Stingray", "Barracuda", "Piranha", "Manatee",
  "Walrus", "Pufferfish", "Jellyfish", "Starfish", "Hermitcrab", "Sandcastle",
  "Beachball", "Innertube", "Rapids",
];

const BAD_NUM = [187, 322, 420, 451, 666, 911];

// Only reached on an actual name collision — exhausting this is
// astronomically unlikely; it exists to bound the retry loop, not because
// it's expected to be hit.
const MAX_CLAIM_ATTEMPTS = 30;

function isValidWord(word, list) {
  return list.includes(word);
}

function pickSuffix() {
  let n;
  do {
    n = 100 + Math.floor(Math.random() * 900);
  } while (BAD_NUM.includes(n));
  return n;
}

module.exports = { NAME_A, NAME_B, BAD_NUM, MAX_CLAIM_ATTEMPTS, isValidWord, pickSuffix };
