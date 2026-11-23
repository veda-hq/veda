// The Stryker config every agnipariksha lane in veda uses (#272). Each
// package's stryker.config.mjs is `export default lane('packages/<name>')`.
//
// The runner is `tap`, on node:test as the suites are written (#238,
// question 1): each owning suite runs as its own `node --test` process, and
// coverage is per test file.
//
// agnipariksha passes the owning suites in AGNIPARIKSHA_SUITES, comma-joined
// and repo-relative (agnipariksha.json's `{suites}`). Stryker runs from the
// package, so the package's prefix is cut off. A hand run without the
// variable leaves `testFiles` out, and the tap runner's default finds every
// suite in the package.

/**
 * @param {string} cwd the package, repo-relative, as agnipariksha.json names it
 * @param {NodeJS.ProcessEnv} [env]
 */
export function lane(cwd, env = process.env) {
  const prefix = `${cwd}/`;
  const suites = (env.AGNIPARIKSHA_SUITES ?? '')
    .split(',')
    .filter((suite) => suite !== '')
    .map((suite) => (suite.startsWith(prefix) ? suite.slice(prefix.length) : suite));
  return {
    testRunner: 'tap',
    plugins: ['@stryker-mutator/tap-runner'],
    tap: {
      ...(suites.length > 0 ? { testFiles: suites } : {}),
      nodeArgs: ['--test-reporter=tap', '-r', '{{hookFile}}', '{{testFile}}'],
      forceBail: true,
    },
    coverageAnalysis: 'perTest',
    checkers: [],
    // Stryker rewrites a lane's tsconfig.json for the sandbox. To do it, it
    // imports `typescript` with no dependency of its own declared, so the
    // import resolves to whatever install a checkout happens to hoist. Some
    // of veda's checkouts hoist TypeScript 7, which has no
    // parseConfigFileTextToJson, and every run there crashed before its
    // first mutant. No lane needs the rewrite: the suites run on node:test,
    // which never reads a tsconfig. So point Stryker at a file that never
    // exists, and the rewrite is skipped.
    tsconfigFile: 'stryker-reads-no-tsconfig.json',
    // agnipariksha prints each blocking mutant itself; clear-text would print each again in full.
    reporters: ['json'],
    // agnipariksha's wrapper config moves the report into reports/agnipariksha/.
    jsonReporter: { fileName: 'reports/mutation/mutation.json' },
    tempDirName: '.stryker-tmp',
    // `true` deletes the sandbox only after a successful run, so every failed
    // dry run left one in the package's .stryker-tmp/, two per refused gate
    // run (veda#437). `always` deletes it however the run ends; it removes
    // only this run's own sandbox-*, and .stryker-tmp/ itself only when empty.
    // A run killed mid-way still leaves its sandbox. To keep one for a look,
    // pass `--cleanTempDir false` on a hand run.
    cleanTempDir: 'always',
    incremental: false,
  };
}
