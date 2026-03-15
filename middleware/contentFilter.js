'use strict';

/**
 * Basic profanity / hate-speech filter.
 * Normalises leetspeak before matching so simple substitutions don't bypass it.
 * Add terms to SLURS to expand coverage.
 */

function normalise(text) {
  return text
    .toLowerCase()
    .replace(/1/g,  'i')
    .replace(/0/g,  'o')
    .replace(/3/g,  'e')
    .replace(/@/g,  'a')
    .replace(/\$/g, 's')
    .replace(/5/g,  's')
    .replace(/4/g,  'a')
    .replace(/\+/g, 't')
    .replace(/[^a-z\s]/g, '');
}

// Slurs and hate-speech terms (word-boundary matched after normalisation).
// Deliberately kept in a single maintainable array — add terms as needed.
const SLURS = [
  // racial
  'nigger', 'nigga', 'chink', 'gook', 'spic', 'spick', 'wetback',
  'kike', 'hymie', 'raghead', 'towelhead', 'zipperhead', 'coon',
  'jigaboo', 'porch monkey', 'sambo', 'beaner', 'greaseball',
  // homophobic / transphobic
  'faggot', 'fag', 'dyke', 'tranny', 'shemale',
  // extremist / hate ideology
  'nazi', 'nazis',
  // sexist / misogynistic
  'cunt', 'whore', 'slut',
  // ableist hate
  'retard',
  // general profanity
  'fuck', 'fucking', 'fucker', 'fucked', 'fucks', 'motherfucker', 'motherfucking',
  'asshole', 'ass hole', 'dumbass', 'dumb ass',
  'bitch', 'bitches',
  'bastard',
  'prick',
  'dickhead', 'dick head',
  'shithead', 'shit head', 'bullshit',
  // insults
  'idiot', 'moron', 'imbecile',
];

// Build regex patterns — word boundary at start only, so plurals/suffixes are caught too
// e.g. \bfaggot matches "faggot", "faggots", "faggotry"
const PATTERNS = SLURS.map(term =>
  new RegExp(`\\b${term.replace(/\s+/g, '\\s+')}`, 'i')
);

// Matches any Extended_Pictographic emoji character
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/**
 * Returns { flagged: false } if clean, or { flagged: true, message: string } if not.
 * @param {string} text
 */
function checkContent(text) {
  if (!text || typeof text !== 'string') return { flagged: false };

  if (EMOJI_RE.test(text))
    return { flagged: true, message: 'Emojis are not allowed.' };

  const norm = normalise(text);
  // Test both original (lowercased) and normalised to catch partial obfuscation
  const lower = text.toLowerCase();
  for (const pattern of PATTERNS) {
    if (pattern.test(lower) || pattern.test(norm)) {
      return { flagged: true, message: 'Your message contains prohibited language.' };
    }
  }
  return { flagged: false };
}

module.exports = { checkContent };
