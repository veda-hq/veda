/**
 * The error-handling family: no-swallowed-catch (ERR-01), safe-log (ERR-02,
 * OBS-03), no-raw-error-string (ERR-03), no-direct-child-process (ERR-08)
 * and google-auth-error-message (its own module). Config blocks that turn
 * them on for source and off for tests live in `./configs.js`.
 */

import { errorHandlingRules } from './error-handling.js';
import { googleAuthErrorMessage } from './google-auth-error-message.js';

export { errorHandlingRules };

export const rules = {
  ...errorHandlingRules,
  'google-auth-error-message': googleAuthErrorMessage,
};
