// Lines readCapabilityVocabulary skips, beside the one token it reads
// (no-capability-literal.test.ts).
// Not a token: the entry does not start its line. OFFSIDE: 'OFFSIDE',
export const Capability = {
  KEPT: 'KEPT',
  TRAILING: 'TRAILING', // Not a token: text follows the comma.
  // Not a token: the key does not start with a capital letter.
  _UNDERSCORE: 'UNDERSCORE',
} as const;
