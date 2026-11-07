// A capability vocabulary module in the shape readCapabilityVocabulary reads
// (no-capability-literal.test.ts): one `KEY: 'TOKEN',` line per capability.
export const Capability = {
  USER_VIEW: 'USER_VIEW',
  ATTENDANCE_VIEW: 'ATTENDANCE_VIEW',
  ATTENDANCE_VIEW_ALL: 'ATTENDANCE_VIEW_ALL',
  INVOICE_RECALCULATE: 'INVOICE_RECALCULATE',
  // Not a token: the value is lowercase.
  LABEL: 'label',
  // Not a token: no trailing comma, so not one entry per line.
  LAST: 'LAST'
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];
