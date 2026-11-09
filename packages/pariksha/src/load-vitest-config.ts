// Prints the coverage exclusions of one vitest config, for coverage-exemptions.
// Runs in its own Node process, under the product's loader (`--import tsx`),
// because a config imports the product's TypeScript as the product compiles it.
import { MARK, readExclude } from './coverage-exemptions.ts';

process.stdout.write(`\n${MARK}${JSON.stringify((await readExclude(process.argv[2] ?? '')) ?? null)}\n`);
