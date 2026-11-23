// The Stryker config of the `scripts` lane in agnipariksha.json (#327): the
// root's own scripts/*.mjs, each judged by the .test.mjs beside it. It is the
// one lane that runs from the repository root (`cwd: ""`), so the suites
// agnipariksha passes are repo-relative already and lane('') cuts nothing.
//
// From the root, Stryker would copy the whole tree into its sandbox:
// packages/, docs/, .tmp/ and, in the main checkout, every worktree under
// .claude/worktrees/. The owning suites need only scripts/ (their fixtures and
// sigstore-trusted-root.json among it), package.json, and agnipariksha.json,
// which mutation-lanes.test.mjs plans veda's own lanes from. Stryker links
// node_modules into the sandbox itself, so everything else stays out.
// pnpm-lock.yaml must stay out too: the mutants that force own-provenance.mjs's
// entry condition true run its real check on import, and with no lockfile in
// the sandbox they die on ENOENT before any request leaves the machine.
//
// A hand run must name the suites (AGNIPARIKSHA_SUITES, as agnipariksha
// does): without them the tap runner's default finds every suite in
// scripts/, and githooks.test.mjs and sarathi-hook.test.mjs need files this
// sandbox leaves out.
import { lane } from './lane.mjs';

export default {
  ...lane(''),
  ignorePatterns: ['/*', '!/scripts/', '!/package.json', '!/agnipariksha.json'],
};
