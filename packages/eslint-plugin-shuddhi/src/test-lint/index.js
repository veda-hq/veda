/**
 * Test-lint rules.
 *
 * Catalogue checks: TEST-WEAK-03 (vacuous assertions), TEST-STRUCT-02 (the
 * test-structure pack), SHELL-09 with TEST-STRUCT-11 (one rule set: script and
 * self-test process hygiene), TEST-WEAK-10 (hand-written SQL fakes) and
 * TEST-WEAK-01 (Detox taps select by testID). Each rule closes a shape code
 * review kept reporting after push; the fixtures in each family's suite are
 * those findings, reduced.
 *
 * LAYOUT. This file is the family's rule map and the wiring of the two
 * factory modules; its config blocks are in `configs.js`. Each rule family is
 * a module here, owned by the colocated suite of the same name:
 * `vacuous-assertion` (TEST-WEAK-03), `test-structure` (TEST-STRUCT-02),
 * `process-hygiene` (SHELL-09 and TEST-STRUCT-11), `sql-fake` (TEST-WEAK-10)
 * and `detox` (TEST-WEAK-01), with two single-rule modules:
 * `jsonnull-in-matcher` (a TEST-WEAK-03 shape: a Prisma null sentinel inside
 * a partial matcher) and `import-meta-cjs` (a SHELL-09 script rule:
 * `import.meta.dirname` in a file tsx runs as CommonJS). `helpers.js` holds
 * only what two or more families read; a family imports nothing from another.
 *
 * `c05.js` adds three to the same test-file block: a test that returns before
 * its assertions with none on the return path, a recursive removal of a path
 * the test did not create, and production SQL copied into a test as its own
 * expectation. `c05-candidates.js` holds their candidate extensions
 * (C05_CANDIDATE_RULES). Both are factories: they receive the shared helpers
 * below rather than importing them.
 *
 * Written against ESTree and the scope manager only: no rule needs type
 * information, so every workspace runs them.
 *
 * WHY NOT TYPE-AWARE. TEST-WEAK-03's catalogue entry says "type-aware". The
 * declared types in tests are routinely lies (`mock as unknown as
 * PrismaService`), so a value typed non-null can be undefined at runtime and
 * `toBeDefined()` on it is a real check. The rule therefore only calls an
 * outcome fixed when JavaScript itself fixes it (`typeof` of a comparison,
 * `toBeDefined()` on an object literal), which no cast can change.
 *
 * ACCEPTED LIMIT. One exception: a call to a built-in Array, String, Number or
 * Date method name (`some`, `includes`, `join`, `indexOf`, ...) is typed by
 * the name alone, since requiring a literal receiver would miss every real
 * finding (`rows.some(f)` on a result). An application object that defines one
 * of those names with another return type is the false positive this admits;
 * its line goes in the workspace's eslint-suppressions.json. The names common
 * on application objects (`has`, `test`, `toString`) are typed only on a
 * receiver syntax shows is the built-in.
 */

import { c05CandidateRules } from './c05-candidates.js';
import { c05Rules } from './c05.js';
import { detoxTapById } from './detox.js';
import {
  assertion,
  calledMethod,
  constInit,
  enclosingFunctions,
  enclosingTest,
  inFinally,
  isFunction,
  ownerOf,
  propertyName,
  registration,
  TEARDOWN_CALLS,
  textOf,
  unwrap,
  variableOf,
  WRAPPERS,
} from './helpers.js';
import { noImportMetaDirnameCjs } from './import-meta-cjs.js';
import { jsonnullInMatcher } from './jsonnull-in-matcher.js';
import {
  cliEntryHelper,
  detachedTeardown,
  envViaStub,
  gitFixtureEnv,
  gitSpawnEnv,
  noGlobalPatch,
  noPartialGitMask,
  noProcessExit,
  noRawGroupKill,
  SHELL_SPAWNERS,
  SPAWNERS,
  spawnTimeout,
} from './process-hygiene.js';
import { noSqlFake } from './sql-fake.js';
import {
  e2eUsesSupertest,
  eachTitleUnique,
  fakeTimersRestored,
  guardedMarkerSlice,
  hermeticConfig,
  mockFactoryHoisted,
  noCollectionTimeIo,
  noCollectionTimeSkipState,
  noNestedTestBlocks,
  noPathLineLiteral,
  noVoidAsyncIife,
  resetSharedLet,
} from './test-structure.js';
import { noVacuousAssertion } from './vacuous-assertion.js';

// ---------------------------------------------------------------------------
// The c05 rules (c05.js) and their candidate extensions (c05-candidates.js).
// Each module is owned by the suite that tests it; both receive the shared
// helpers from helpers.js.
// ---------------------------------------------------------------------------

const {
  noSilentEarlyReturn,
  ownedFixtureRemoval,
  noCopiedProductionSql,
  someNode,
  OWNED_ROOT_CALLS,
  SOURCE_EXTENSIONS,
} = c05Rules({
  isFunction,
  unwrap,
  propertyName,
  registration,
  assertion,
  variableOf,
  constInit,
});
const {
  noFixedSleep,
  specificRejection,
  callSpecificMatcher,
  independentExpectation,
  ownedDbSchema,
  teardownInFinally,
  cleanupLoopSettles,
  parseStructuredConfig,
  mockStateReset,
  mockExportParity,
  spawnResultChecked,
  localToolSpawn,
  fixtureRootTracked,
} = c05CandidateRules({
  isFunction,
  WRAPPERS,
  unwrap,
  propertyName,
  calledMethod,
  registration,
  ownerOf,
  enclosingFunctions,
  enclosingTest,
  assertion,
  variableOf,
  constInit,
  textOf,
  inFinally,
  TEARDOWN_CALLS,
  SPAWNERS,
  SHELL_SPAWNERS,
  someNode,
  OWNED_ROOT_CALLS,
  SOURCE_EXTENSIONS,
});

// ---------------------------------------------------------------------------
// Rule map
// ---------------------------------------------------------------------------

export const rules = {
  'no-vacuous-assertion': noVacuousAssertion,
  'fake-timers-restored': fakeTimersRestored,
  'mock-factory-hoisted': mockFactoryHoisted,
  'no-nested-test-blocks': noNestedTestBlocks,
  'each-title-unique': eachTitleUnique,
  'no-collection-time-skip-state': noCollectionTimeSkipState,
  'no-collection-time-io': noCollectionTimeIo,
  'guarded-marker-slice': guardedMarkerSlice,
  'reset-shared-let': resetSharedLet,
  'hermetic-config': hermeticConfig,
  'e2e-uses-supertest': e2eUsesSupertest,
  'no-void-async-iife': noVoidAsyncIife,
  'no-path-line-literal': noPathLineLiteral,
  'no-process-exit': noProcessExit,
  'cli-entry-helper': cliEntryHelper,
  'git-spawn-env': gitSpawnEnv,
  'git-fixture-env': gitFixtureEnv,
  'no-global-patch': noGlobalPatch,
  'no-sql-fake': noSqlFake,
  'detox-tap-by-id': detoxTapById,
  'no-silent-early-return': noSilentEarlyReturn,
  'owned-fixture-removal': ownedFixtureRemoval,
  'no-copied-production-sql': noCopiedProductionSql,
  'no-fixed-sleep': noFixedSleep,
  'specific-rejection': specificRejection,
  'call-specific-matcher': callSpecificMatcher,
  'independent-expectation': independentExpectation,
  'owned-db-schema': ownedDbSchema,
  'teardown-in-finally': teardownInFinally,
  'cleanup-loop-settles': cleanupLoopSettles,
  'parse-structured-config': parseStructuredConfig,
  'mock-state-reset': mockStateReset,
  'mock-export-parity': mockExportParity,
  'spawn-result-checked': spawnResultChecked,
  'local-tool-spawn': localToolSpawn,
  'fixture-root-tracked': fixtureRootTracked,
  'no-partial-git-mask': noPartialGitMask,
  'env-via-stub': envViaStub,
  'spawn-timeout': spawnTimeout,
  'no-raw-group-kill': noRawGroupKill,
  'detached-teardown': detachedTeardown,
  'jsonnull-in-matcher': jsonnullInMatcher,
  'no-import-meta-dirname-cjs': noImportMetaDirnameCjs,
};

/** The c05 candidate extensions (`c05-candidates.js`), in catalogue order. */
export const C05_CANDIDATE_RULES = [
  'no-fixed-sleep',
  'specific-rejection',
  'call-specific-matcher',
  'independent-expectation',
  'owned-db-schema',
  'teardown-in-finally',
  'cleanup-loop-settles',
  'parse-structured-config',
  'mock-state-reset',
  'mock-export-parity',
  'spawn-result-checked',
  'local-tool-spawn',
  'fixture-root-tracked',
];

/**
 * The family as a plugin, for binding under any namespace. `configs.js`
 * binds this same object for its default namespace, so a config that also
 * registers it directly does not redefine the plugin.
 */
const plugin = { meta: { name: 'shuddhi' }, rules };
export default plugin;
