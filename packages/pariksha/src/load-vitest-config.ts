// Answers, on fd 3, with the coverage exclusions of one vitest config, for
// coverage-exemptions. Runs in its own Node process, under the product's loader
// (`--import tsx`), because a config imports the product's TypeScript as the
// product compiles it. It exits once answered: a config's open timer or handle
// must not hold the run.
import { writeSync } from 'node:fs';
import { readExclude } from './coverage-exemptions.ts';

const exclude = await readExclude(process.argv[2] ?? '');
// A function or symbol stringifies to undefined; it is no list either way.
writeSync(3, JSON.stringify(exclude ?? null) ?? 'null');
process.exit(0);
