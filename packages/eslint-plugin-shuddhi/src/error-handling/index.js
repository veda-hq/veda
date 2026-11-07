/**
 * The error-handling family: no-swallowed-catch (ERR-01), safe-log (ERR-02,
 * OBS-03), no-raw-error-string (ERR-03) and no-direct-child-process (ERR-08).
 * Config blocks that turn them on for source and off for tests live in
 * `./configs.js`.
 */

import { errorHandlingRules } from './error-handling.js';

export { errorHandlingRules };

export const rules = { ...errorHandlingRules };
