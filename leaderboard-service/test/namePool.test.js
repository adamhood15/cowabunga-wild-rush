const test = require("node:test");
const assert = require("node:assert/strict");
const { NAME_A, NAME_B, BAD_NUM, isValidWord, pickSuffix } = require("../src/namePool");

test("word pool sizes match the audited DATABASE.md counts (99 x 100)", () => {
  assert.equal(NAME_A.length, 99);
  assert.equal(NAME_B.length, 100);
});

test("word lists contain no duplicates", () => {
  assert.equal(new Set(NAME_A).size, NAME_A.length);
  assert.equal(new Set(NAME_B).size, NAME_B.length);
});

test("isValidWord only accepts exact, case-sensitive matches from the given list", () => {
  assert.equal(isValidWord("Dusty", NAME_A), true);
  assert.equal(isValidWord("dusty", NAME_A), false); // case-sensitive, mirrors PHP's in_array(..., true)
  assert.equal(isValidWord("Longhorn", NAME_A), false); // a NAME_B word, wrong list
  assert.equal(isValidWord("NotARealWord", NAME_A), false);
});

// Mirrors what /claim actually enforces (src/index.js:
// isValidWord(adjective, NAME_A) && isValidWord(noun, NAME_B)) — a rogue
// name is anything not drawn verbatim from the closed lists, whether it's
// plain nonsense, an injection attempt, or a near-miss on a real word.
test("isValidWord rejects rogue names — nothing outside the closed list is ever valid", () => {
  const rogueCandidates = [
    "",                          // empty
    " ",                         // whitespace only
    "Dusty ",                    // trailing whitespace on an otherwise-real word
    " Dusty",                    // leading whitespace
    "Dusty\n",                   // trailing newline
    "Dusty Buckaroo",            // a full adjective+noun pair, not a single word
    "Dustybuckaroo",             // two real words mashed together
    "DUSTY",                     // wrong case
    "Duzty",                     // near-miss typo on a real word
    "Rootin'",                   // a fragment of the real "Rootin'-tootin'" compound
    "'; DROP TABLE stampede_scores; --", // SQL-injection-shaped
    "<script>alert(1)</script>", // XSS-shaped
    "../../etc/passwd",          // path-traversal-shaped
    "Dusty\u0000",                // embedded null byte after a real word
    "𝔇𝔲𝔰𝔱𝔶",                     // unicode-lookalike of "Dusty", not the real bytes
  ];

  for (const candidate of rogueCandidates) {
    assert.equal(isValidWord(candidate, NAME_A), false, `NAME_A should reject: ${JSON.stringify(candidate)}`);
    assert.equal(isValidWord(candidate, NAME_B), false, `NAME_B should reject: ${JSON.stringify(candidate)}`);
  }
});

test("a claim is only accepted when BOTH words come from their own list — a rogue word on either side fails the whole pair", () => {
  // This is exactly the && a real /claim handler evaluates.
  const wouldClaim = (adjective, noun) => isValidWord(adjective, NAME_A) && isValidWord(noun, NAME_B);

  assert.equal(wouldClaim("Dusty", "Buckaroo"), true); // both real, real pair
  assert.equal(wouldClaim("Dusty", "Nonexistent"), false); // rogue noun
  assert.equal(wouldClaim("Nonexistent", "Buckaroo"), false); // rogue adjective
  assert.equal(wouldClaim("Buckaroo", "Dusty"), false); // real words, but swapped lists
  assert.equal(wouldClaim("Nonexistent", "Nonexistent"), false); // rogue on both sides
});

test("pickSuffix always returns a 3-digit number outside the blocklist", () => {
  for (let i = 0; i < 5000; i++) {
    const n = pickSuffix();
    assert.ok(n >= 100 && n <= 999, `suffix ${n} out of the expected 100-999 range`);
    assert.ok(!BAD_NUM.includes(n), `suffix ${n} should never be a blocklisted number`);
  }
});
