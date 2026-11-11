/**
 * masked-exit-codes: ported case for case from the original's suite. The
 * three defects that motivated the check (a commit-message linter followed
 * by `exit 0`, a review step whose failures read as passes, a baseline read
 * with `2>/dev/null || true`) must keep failing; if they ever stop, the
 * check has become decoration. Most cases run under PRODUCT, the config the
 * product that owned the original passes, so its gate list and pipefail
 * scope are the ones these cases were written against.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from './cli.ts';
import {
  DEFAULT_GATE_COMMANDS,
  DEFAULT_MASKED_CONFIG,
  executedTexts,
  findMaskedExits,
  foldContinuations,
  formatMasked,
  handlerStarts,
  isPipefailScoped,
  type MaskedConfig,
  parseMaskedConfig,
  readerFor,
  readWorkingTree,
  renderPrintf,
  shellFiles,
  type SourceReader,
  stagedReader,
  withoutQuotedText,
} from './masked-exit-codes.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

/** The original's own gate list and pipefail scope, as its product's config gives them. */
const PRODUCT: MaskedConfig = {
  id: 'SH-001',
  gateCommands: [...DEFAULT_GATE_COMMANDS, 'run-validation.sh'],
  hookDirs: ['.husky/'],
  pipefailScope: [/^\.husky\//, /^scripts\/(?:lib|validations|package-validations)\/.+\.sh$/],
};

const PRODUCT_JSON = JSON.stringify({ id: PRODUCT.id, gateCommands: PRODUCT.gateCommands, hookDirs: PRODUCT.hookDirs, pipefailScope: PRODUCT.pipefailScope.map((r) => r.source) });

const fixture = (files: Record<string, string>): { root: string; names: string[] } => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-masked-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, dirname(name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  return { root, names: Object.keys(files) };
};

const find = (root: string, names: readonly string[], read: SourceReader = readWorkingTree) => findMaskedExits(root, names, read, PRODUCT);

describe('masked-exit-codes: which files are shell', () => {
  it('lists tracked .sh files and hooks, never node_modules or untracked files', () => {
    const { root } = fixture({
      'scripts/validations/a.sh': 'echo a\n',
      '.husky/pre-commit': 'echo hook\n',
      'lib/b.ts': 'export {};\n',
      'pkg/node_modules/dep/c.sh': 'echo c\n',
      'untracked.sh': 'echo u\n',
    });
    execFileSync('git', ['init', '-q'], { cwd: root, env: ENV });
    execFileSync('git', ['add', '-f', '--', 'scripts/validations/a.sh', '.husky/pre-commit', 'lib/b.ts', 'pkg/node_modules/dep/c.sh'], { cwd: root, env: ENV });
    assert.deepEqual(shellFiles(root).sort(), ['.husky/pre-commit', 'scripts/validations/a.sh']);
    // Another hook directory is the config's to name.
    assert.deepEqual(shellFiles(root, { ...PRODUCT, hookDirs: ['lib/'] }).sort(), ['lib/b.ts', 'scripts/validations/a.sh']);
  });
});

describe('masked-exit-codes: the historical defects must still fail', () => {
  it('treats shellcheck as a gate whose status must not be discarded', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'shellcheck a.sh || true', ''].join('\n') });
    const problems = find(root, names);
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.reason ?? '', /discards its exit status/);
  });

  it('catches commitlint followed by an unconditional exit 0', () => {
    const { root, names } = fixture({ 'hook.sh': ['#!/usr/bin/env bash', 'npx commitlint --edit "$1"', 'exit 0', ''].join('\n') });
    assert.deepEqual(find(root, names), [
      {
        file: 'hook.sh',
        // The `exit 0` line, where the mask sits.
        line: 3,
        snippet: 'npx commitlint --edit "$1"  →  exit 0',
        reason: 'unconditional `exit 0` right after `commitlint` — the script always succeeds, whatever the gate decided',
      },
    ]);
  });

  it('catches a gate whose exit status is thrown away with || true', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'eslint . --max-warnings=0 || true', ''].join('\n') });
    const problems = find(root, names);
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.reason ?? '', /discards its exit status/);
  });

  it('catches a mask on the continued line of the same command', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'eslint . \\', '  --max-warnings=0 \\', '  || true', ''].join('\n') });
    const problems = find(root, names);
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.reason ?? '', /discards its exit status/);
    // Reported against the line the command starts on, where a reader looks.
    assert.equal(problems[0]?.line, 2);
  });

  it('still reports nothing for a continued command carrying no mask', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'eslint . \\', '  --max-warnings=0', ''].join('\n') });
    assert.deepEqual(find(root, names), []);
  });

  it('catches a gate with stderr discarded and status unchecked', () => {
    // A command after the gate takes over the exit status, which is what
    // makes the discarded status invisible.
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'gitleaks detect 2>/dev/null', 'echo "scan complete"', ''].join('\n') });
    const problems = find(root, names);
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.reason ?? '', /indistinguishable from a pass/);
  });
});

describe('masked-exit-codes: legitimate shapes must not fail', () => {
  it('allows `|| true` on a grep whose pattern merely contains a tool name', () => {
    // grep exits 1 on no match, so `|| true` is correct, and "eslint" here
    // is a search string.
    const { root, names } = fixture({ 'scan.sh': ['#!/usr/bin/env bash', 'VIOLATIONS=$(echo "$FILES" | xargs grep -nE "eslint-plugin" 2>/dev/null || true)', ''].join('\n') });
    assert.deepEqual(find(root, names), []);
  });

  it('allows capture-then-branch, where the verdict moves into a variable', () => {
    const { root, names } = fixture({ 'wf.sh': ['#!/usr/bin/env bash', 'OUTPUT=$(actionlint -shellcheck= "$file" 2>&1 || true)', 'if [ -n "$OUTPUT" ]; then exit 1; fi', ''].join('\n') });
    assert.deepEqual(find(root, names), []);
  });

  it('allows a saved status that a later branch exits on', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'eslint . || rc=$?', 'echo "lint finished"', 'if [ "${rc:-0}" -ne 0 ]; then', '  exit "$rc"', 'fi', ''].join('\n') });
    assert.deepEqual(find(root, names), []);
  });

  const saved: Array<[string, string[], number]> = [
    ['a diagnostic read before the deciding branch', ['echo "lint status $rc"', 'if [ "${rc:-0}" -ne 0 ]; then exit "$rc"; fi'], 0],
    ['a one-line `|| exit "$rc"` test', ['[ "${rc:-0}" -eq 0 ] || exit "$rc"'], 0],
    ['a branch that exits 0', ['if [ "${rc:-0}" -ne 0 ]; then exit 0; fi'], 1],
    ['a bare exit (the test status, 0)', ['if [ "${rc:-0}" -ne 0 ]; then', '  exit', 'fi'], 1],
    ['a reassignment before the branch', ['rc=0', 'if [ "$rc" -ne 0 ]; then exit "$rc"; fi'], 1],
    ['an exit that runs only on success', ['if [ "${rc:-0}" -eq 0 ]; then exit "$rc"; fi', 'echo passed'], 1],
    ['a success test whose || exits', ['[ "${rc:-0}" -eq 0 ] || exit "$rc"'], 0],
    ['the else of a success test', ['if [ "${rc:-0}" -eq 0 ]; then', '  echo ok', 'else', '  exit "$rc"', 'fi'], 0],
    ['a failure test whose || exits', ['[ "${rc:-0}" -ne 0 ] || exit "$rc"'], 1],
  ];
  for (const [name, after, count] of saved) {
    it(`judges a saved status by its exit: ${name}`, () => {
      const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'eslint . || rc=$?', ...after, ''].join('\n') });
      assert.equal(find(root, names).length, count);
    });
  }

  for (const line of ['eslint . || { exit; }', 'eslint . || { echo failed; exit 1 >&2; }']) {
    it(`accepts a handler that hands the failure on: ${JSON.stringify(line)}`, () => {
      const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'set -e', line, ''].join('\n') });
      assert.deepEqual(find(root, names), []);
    });
  }

  it('reads what printf writes, not its words one by one', () => {
    const { root, names } = fixture({
      'masked.sh': "#!/usr/bin/env bash\nprintf '%s%s\\n' eslint ' . || true' | sh\n",
      'comment.sh': "#!/usr/bin/env bash\nprintf '%s%s\\n' '# ' 'eslint . || true' | sh\n",
    });
    assert.deepEqual(
      find(root, names).map((found) => found.file),
      ['masked.sh'],
    );
  });

  for (const line of ["echo $(sh -c 'eslint . || true')", "echo $(printf '%s\\n' 'eslint . || true' | sh | cat)"]) {
    it(`reads a script a substitution hands a shell: ${JSON.stringify(line)}`, () => {
      const { root, names } = fixture({ 'gate.sh': `#!/usr/bin/env bash\n${line}\n` });
      assert.equal(find(root, names).length, 1);
    });
  }

  for (const line of ['eslint . || { echo failed; exit; }', 'eslint . || { false && exit 1; }']) {
    it(`catches a brace handler whose exit may not run: ${JSON.stringify(line)}`, () => {
      const { root, names } = fixture({ 'gate.sh': `#!/usr/bin/env bash\n${line}\necho passed\n` });
      assert.equal(find(root, names).length, 1);
    });
  }

  it('catches a saved status that nothing exits on', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'eslint . || rc=$?', 'echo "lint status $rc"', 'if [ "${rc:-0}" -ne 0 ]; then', '  echo "lint failed"', 'fi', 'exit 0', ''].join('\n') });
    assert.equal(find(root, names).length, 1);
  });

  it('catches a capture whose variable is never tested', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'OUTPUT=$(eslint . --max-warnings=0 || true)', 'echo "done"', ''].join('\n') });
    const problems = find(root, names);
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.reason ?? '', /never tested|discards its exit status|does not exit non-zero/);
  });

  it('sees a gate invoked after `!`', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', '! eslint . --max-warnings=0 2>/dev/null', 'echo done', ''].join('\n') });
    const problems = find(root, names);
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.reason ?? '', /indistinguishable from a pass/);
  });

  it('sees a gate inside a shell group', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', '( ! eslint . --max-warnings=0 2>/dev/null )', 'echo done', ''].join('\n') });
    assert.equal(find(root, names).length, 1);
  });

  it('reports a gate whose failure is converted to success', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'eslint . --max-warnings=0 2>/dev/null || exit 0', 'echo done', ''].join('\n') });
    assert.equal(find(root, names).length, 1);
  });

  it('allows a gate that propagates its failure with a non-zero exit', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'eslint . --max-warnings=0 2>/dev/null || exit 1', 'echo done', ''].join('\n') });
    assert.deepEqual(find(root, names), []);
  });

  it('allows `|| false`, which leaves the condition failed', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'if eslint . || false; then echo passed; else exit 1; fi', ''].join('\n') });
    assert.deepEqual(find(root, names), []);
  });

  it('still reports a handler that turns the condition true', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'if eslint . || echo failed; then echo passed; else exit 1; fi', ''].join('\n') });
    assert.equal(find(root, names).length, 1);
  });

  it('allows a gate that branches on its own status', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'if ! eslint . --max-warnings=0; then exit 1; fi', 'exit 0', ''].join('\n') });
    assert.deepEqual(find(root, names), []);
  });

  it('catches a gate whose status is captured and then discarded', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'eslint . --max-warnings=0', 'STATUS=$?', 'exit 0', ''].join('\n') });
    const problems = find(root, names);
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.reason ?? '', /unconditional `exit 0`/);
  });

  it('allows a captured status that is actually branched on', () => {
    const { root, names } = fixture({ 'gate.sh': ['#!/usr/bin/env bash', 'eslint . --max-warnings=0', 'STATUS=$?', 'if [ "$STATUS" -ne 0 ]; then exit 1; fi', 'exit 0', ''].join('\n') });
    assert.deepEqual(find(root, names), []);
  });

  it('allows an exit 0 that follows something which is not a gate', () => {
    const { root, names } = fixture({ 'ok.sh': ['#!/usr/bin/env bash', 'echo "all done"', 'exit 0', ''].join('\n') });
    assert.deepEqual(find(root, names), []);
  });
});

describe('masked-exit-codes: where a gate counts as run', () => {
  const masked = (...body: string[]): number => {
    const { root, names } = fixture({ 'gate.sh': [...body, ''].join('\n') });
    return find(root, names).length;
  };

  it('ignores a commented-out gate, and reports the same line live', () => {
    assert.equal(masked('# cd app && eslint . || true'), 0);
    assert.equal(masked('cd app && eslint . || true'), 1);
  });

  it('sees a gate run from a local bin path or through a shell', () => {
    assert.equal(masked('./node_modules/.bin/eslint . || true'), 1);
    assert.equal(masked('apps/web/node_modules/.bin/eslint . || true'), 1);
    assert.equal(masked('bash run-validation.sh lint || true'), 1);
    // The shape every hook of the original's product writes.
    assert.equal(masked('bash scripts/run-validation.sh lint || true'), 1);
    assert.equal(masked('bash scripts/run-validation.sh lint 2>/dev/null'), 1);
    assert.equal(masked('bash scripts/run-validation.sh lint || exit 1'), 0);
  });

  it('exempts a capture only when a later line tests that variable', () => {
    const capture = 'OUTPUT=$(eslint . || true)';
    // A later decision about something else does not read the verdict.
    assert.equal(masked(capture, 'if [ -f x ]; then exit 1; fi'), 1);
    // A later read that decides nothing does not either.
    assert.equal(masked(capture, 'echo "$OUTPUT"'), 1);
    // A test before the capture saw an older value.
    assert.equal(masked('if [ -n "$OUTPUT" ]; then exit 1; fi', capture), 1);
    assert.equal(masked(capture, '[ -n "${OUTPUT}" ] && exit 1'), 0);
  });

  it('walks back from exit 0 to a gate on the first line', () => {
    const { root, names } = fixture({ 'gate.sh': 'eslint .\nexit 0\n' });
    assert.deepEqual(
      find(root, names).map((p) => p.line),
      [2],
    );
  });

  it('walks back over blank and comment lines, four lines at most', () => {
    assert.equal(masked('#!/usr/bin/env bash', 'eslint .', '', '# done', '', 'exit 0'), 1);
    assert.equal(masked('#!/usr/bin/env bash', 'eslint .', '', '#', '', '#', 'exit 0'), 0);
  });

  it('stops the walk at a line that names a gate without running it', () => {
    assert.equal(masked('eslint .', 'cat eslint.config.js', 'exit 0'), 0);
  });

  it('walks past echo and printf lines, which print rather than decide', () => {
    assert.equal(masked('eslint .', 'echo done', 'printf "%s\\n" ok', 'exit 0'), 1);
  });

  it('judges only the gates the config names', () => {
    const { root, names } = fixture({ 'gate.sh': 'mytool check || true\n' });
    assert.deepEqual(find(root, names), []);
    assert.equal(findMaskedExits(root, names, readWorkingTree, { ...PRODUCT, gateCommands: ['mytool check'] }).length, 1);
    // A command of several words must appear whole.
    assert.deepEqual(findMaskedExits(root, names, readWorkingTree, { ...PRODUCT, gateCommands: ['mytool run'] }), []);
  });
});

describe('foldContinuations', () => {
  it('drops each continuation marker and keeps the starting line number', () => {
    assert.deepEqual(foldContinuations(['eslint . \\', '  || true', 'echo x']), [
      { text: 'eslint .  || true', line: 1 },
      { text: 'echo x', line: 3 },
    ]);
  });

  it('keeps a command that ends mid-continuation', () => {
    assert.deepEqual(foldContinuations(['a \\']), [{ text: 'a ', line: 1 }]);
  });
});

describe('handlerStarts', () => {
  it('reads an `||` inside `${ … }` as text, as bash does', () => {
    // a(0) ' '(1) $(2) {(3) … }(11) ' '(12) |(13): only the last is an operator.
    assert.deepEqual(handlerStarts('a ${U:-x||y} || b'), [13]);
  });

  // A `case` arm's `)` closes nothing; `\` escapes nothing inside single quotes.
  for (const list of ['a || b', 'a "x||y" || b', "a 'x||y' || b", 'a x\\|\\|y || b', 'a "x\\"||y" || b', "a 'x\\' || b", 'a $(x || y) || b', 'a ( x || y ) || b', 'a { x || y; } || b', 'a ${U} || b', 'x) a || b']) {
    it(`finds the one operator in ${JSON.stringify(list)}`, () => {
      assert.deepEqual(handlerStarts(list), [list.lastIndexOf('||')]);
    });
  }

  it('finds every operator after a closed group', () => {
    const list = 'a $(x) || b || c';
    assert.deepEqual(handlerStarts(list), [list.indexOf('||'), list.lastIndexOf('||')]);
  });

  for (const list of ['a "x || b', "a 'x || b", 'a $(x || b']) {
    it(`finds none inside what stays open: ${JSON.stringify(list)}`, () => {
      assert.deepEqual(handlerStarts(list), []);
    });
  }
});

/**
 * Hook checks gated on `if echo "$LIST" | grep -q`: under pipefail that
 * reads a match as a miss whenever grep exits before echo's last write, and
 * the gated check silently does not run.
 */
describe('masked-exit-codes: an early-exit reader fed from a variable', () => {
  const hook = (body: string): string => ['#!/usr/bin/env bash', 'set -euo pipefail', body, ''].join('\n');

  const caught: Array<[string, string]> = [
    ['grep -qE', `if echo "$UNPUSHED_FILES" | grep -qE 'Dockerfile'; then`],
    ['negated grep -q', `if ! echo "$X" | grep -q "^a|b$"; then`],
    ['printf into grep -m', `y=$(printf '%s\\n' "$X" | grep -m1 a)`],
    ['grep -l', `echo "\${X}" | grep -l a`],
    ['grep --quiet after the pattern', `echo "$X" | grep a --quiet`],
    ['head', `echo "  \${OUT:0:200}" | head -3`],
    ['an expansion beside an escaped dollar', `echo "\\$5 $X" | grep -q a`],
    ['a condition chain', `[ "$A" -ne 1 ] && echo "$OUT" | grep -q "Too Large"`],
    ['--max-count=', `echo "$X" | grep --max-count=1 a`],
    ['grep -L', `echo "$X" | grep -L a`],
    ['-q after a lone - (stdin)', `echo "$X" | grep a - -q`],
    ['--files-without-match', `echo "$X" | grep --files-without-match a`],
    ['-q after an -e value', `echo "$X" | grep -e a -q`],
    ['-q after a long value option', `echo "$X" | grep --regexp a -q`],
  ];
  for (const [shape, line] of caught) {
    it(`catches ${shape}`, () => {
      const { root, names } = fixture({ '.husky/pre-push': hook(line) });
      const problems = find(root, names);
      assert.equal(problems.length, 1);
      assert.equal(problems[0]?.file, '.husky/pre-push');
      assert.equal(problems[0]?.line, 3);
      assert.match(problems[0]?.reason ?? '', /here-string/);
    });
  }

  const allowed: Array<[string, string]> = [
    ['the here-string fix', `if grep -qE 'Dockerfile' <<<"$UNPUSHED_FILES"; then`],
    ['a reader that consumes everything', `Y=$(echo "$X" | grep -E 'a' || true)`],
    ['a literal with no variable', `echo "done" | grep -q done`],
    ['a pipe character inside the pattern', `if echo "$X" | grep -E 'q|head'; then`],
    ['an or-list, not a pipe', `echo "$X" || grep -q a file`],
    ['a comment', `# if echo "$X" | grep -q a; then`],
    ['a dollar quoted inside single quotes', `if echo 'say "$HOME"' | grep -q a; then`],
    ['an escaped dollar in quotes', `echo "\\$HOME" | grep -q HOME`],
    ['an escaped dollar unquoted', `echo \\$HOME | grep -q HOME`],
    ['a pattern after -e that looks like -m', `echo "$X" | grep -e -missing`],
    ['a pattern after --regexp', `echo "$X" | grep --regexp -missing`],
    ['an attached -e value', `echo "$X" | grep -E -emissing`],
    ['a value option before the pattern', `echo "$X" | grep -A 1 -e a -`],
    ['options ended by --', `echo "$X" | grep -- -q`],
    ['an unquoted pattern holding q', `echo "$X" | grep aqua`],
  ];
  for (const [shape, line] of allowed) {
    it(`allows ${shape}`, () => {
      const { root, names } = fixture({ '.husky/pre-commit': hook(line) });
      assert.deepEqual(find(root, names), []);
    });
  }

  it('judges the staged blob under --staged, not the working tree', () => {
    const { root, names } = fixture({ '.husky/pre-push': hook(`if grep -q a <<<"$X"; then :; fi`) });
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: ENV });
    git('init', '-q');
    writeFileSync(join(root, '.husky/pre-push'), hook(`if echo "$X" | grep -q a; then :; fi`));
    git('add', '.husky/pre-push');
    writeFileSync(join(root, '.husky/pre-push'), hook(`if grep -q a <<<"$X"; then :; fi`));
    assert.deepEqual(find(root, names), []);
    const staged = find(root, names, stagedReader(ENV));
    assert.equal(staged.length, 1);
    assert.match(staged[0]?.reason ?? '', /here-string/);
    // A path missing from the index is skipped, as a deleted file is.
    assert.deepEqual(find(root, ['.husky/absent'], stagedReader(ENV)), []);
  });

  it('fails closed when a file cannot be read, rather than skipping it', () => {
    const { root } = fixture({ '.husky/pre-push': hook(':') });
    // Not a git repository: the index cannot be read at all.
    assert.throws(() => find(root, ['.husky/pre-push'], stagedReader({ ...ENV, GIT_CEILING_DIRECTORIES: dirname(root) })), /not a git repository/i);
    // A directory is present but unreadable as text: EISDIR, not ENOENT.
    assert.throws(() => find(root, ['.husky'], readWorkingTree), /EISDIR/);
    // A path through a file is a lookup error, not an absent file.
    assert.throws(() => find(root, ['.husky/pre-push/x'], readWorkingTree), /ENOTDIR/);
    assert.deepEqual(find(root, ['.husky/gone'], readWorkingTree), []);
  });

  it('collapses quoted and escaped text to placeholders', () => {
    assert.equal(withoutQuotedText(String.raw`echo "a" "$X" "\$Y" "\\$Z" 'q|$W' \$V \| x`), `echo "" "$" "" "$" '' _V _ x`);
  });

  it('picks the index reader for --staged and the working tree otherwise', () => {
    assert.equal(readerFor(false), readWorkingTree);
    assert.notEqual(readerFor(true), readWorkingTree);
  });

  it('holds hooks, sourced libraries and validators only', () => {
    assert.equal(isPipefailScoped('.husky/commit-msg', PRODUCT), true);
    assert.equal(isPipefailScoped('scripts/lib/preflight-mode.sh', PRODUCT), true);
    assert.equal(isPipefailScoped('scripts/lib/preflight-mode.test.ts', PRODUCT), false);
    assert.equal(isPipefailScoped('scripts/validations/api/check.sh', PRODUCT), true);
    assert.equal(isPipefailScoped('scripts/validations/documentation/__fixtures__/test-rfc-validator.sh', PRODUCT), true);
    assert.equal(isPipefailScoped('scripts/validations/code-quality/check.test.ts', PRODUCT), false);
    assert.equal(isPipefailScoped('scripts/validations.sh', PRODUCT), false);
    assert.equal(isPipefailScoped('scripts/package-validations/validators/absolute-paths.sh', PRODUCT), true);
    assert.equal(isPipefailScoped('scripts/package-validations.sh', PRODUCT), false);
    assert.equal(isPipefailScoped('apps/server/scripts/scan-container.sh', PRODUCT), false);
    const { root, names } = fixture({ 'apps/server/scripts/scan.sh': hook(`echo "$X" | grep -q a`) });
    assert.deepEqual(find(root, names), []);
  });

  it('holds the hook directory only by default', () => {
    assert.equal(isPipefailScoped('.husky/commit-msg'), true);
    assert.equal(isPipefailScoped('scripts/lib/preflight-mode.sh'), false);
  });

  it('catches the shape in a validator', () => {
    const { root, names } = fixture({ 'scripts/validations/security/check-headers.sh': hook(`if ! echo "$FILE_CONTENT" | grep -qE "import.*helmet"; then`) });
    assert.deepEqual(
      find(root, names).map((p) => [p.file, p.line]),
      [['scripts/validations/security/check-headers.sh', 3]],
    );
  });

  // Past the pipe buffer the miss is deterministic, so this pins the reason
  // for the rule rather than a flaky rate.
  it('is a real miss under pipefail, and the here-string is not', () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          `LIST="$(printf 'package.json\\n'; printf 'scripts/lib/file-%s.ts\\n' $(seq 1 6000))"`,
          '[ "${#LIST}" -gt $((2 * 64 * 1024)) ]',
          'pipe=0 here=0',
          'for _ in 1 2 3 4 5; do',
          `  if echo "$LIST" 2>/dev/null | grep -q '^package\\.json$'; then pipe=$((pipe + 1)); fi`,
          `  if grep -q '^package\\.json$' <<<"$LIST"; then here=$((here + 1)); fi`,
          'done',
          'echo "$pipe $here"',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim(), '0 5');
  });
});

describe('masked-exit-codes: the command', () => {
  /** A committed repository holding `files` and the product's config. */
  const repo = (files: Record<string, string>): string => {
    const { root } = fixture({ ...files, 'masked.json': PRODUCT_JSON });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: ENV });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'base');
    return root;
  };

  const cli = (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(['masked-exit-codes', ...args], { out: (l) => out.push(l), err: (l) => err.push(l) }, '0.0.0');
    return { code, out, err };
  };

  const CLEAN = '#!/usr/bin/env bash\nshellcheck a.sh\n';
  const MASKED = '#!/usr/bin/env bash\nshellcheck a.sh || true\n';

  it('passes a clean tree, counting the files it scanned', () => {
    const root = repo({ 'gate.sh': CLEAN, 'other.sh': CLEAN });
    assert.deepEqual(cli(['--root', root, '--config', 'masked.json']), { code: 0, out: ['✅ SH-001: no masked exit codes (2 shell file(s) scanned)'], err: [] });
  });

  it('judges the working directory when no --root is given', () => {
    const root = repo({ 'gate.sh': MASKED });
    const cwd = process.cwd();
    process.chdir(root);
    try {
      assert.deepEqual(cli(['--config', 'masked.json']), {
        code: 1,
        out: [],
        err: [
          '\n❌ SH-001: 1 masked exit code(s)\n',
          ' gate.sh:2',
          '   shellcheck a.sh || true',
          '   `shellcheck` is a gate, but `|| true` discards its exit status — the check reports success whatever it found\n',
          'A gate that cannot fail is not a gate. Branch on the status, or drop the check.\n',
        ],
      });
    } finally {
      process.chdir(cwd);
    }
  });

  it('judges the index with --staged, and the working tree without it', () => {
    const root = repo({ 'gate.sh': CLEAN });
    writeFileSync(join(root, 'gate.sh'), MASKED);
    assert.equal(cli(['--root', root, '--staged']).code, 0);
    assert.equal(cli(['--root', root]).code, 1);
  });

  it('fails closed when it finds no shell files at all', () => {
    const root = repo({ 'readme.md': '# x\n' });
    assert.deepEqual(cli(['--root', root, '--config', 'masked.json']), { code: 1, out: [], err: ['❌ SH-001: no shell files found — the file lookup failed'] });
  });

  it('names itself by default', () => {
    const root = repo({ 'gate.sh': CLEAN });
    assert.deepEqual(cli(['--root', root]).out, ['✅ masked-exit-codes: no masked exit codes (1 shell file(s) scanned)']);
  });

  it('refuses an unknown option as a usage error', () => {
    const result = cli(['--fix']);
    assert.equal(result.code, 2);
    assert.match(result.err.join('\n'), /^usage: /);
  });

  it('refuses a bad config, or no repository, as unchecked', () => {
    const root = repo({ 'gate.sh': CLEAN, 'bad.json': '{"gates": []}' });
    assert.deepEqual(cli(['--root', root, '--config', 'bad.json']), { code: 2, out: [], err: ['pariksha masked-exit-codes: unknown key "gates"; nothing was checked, so this is not a pass'] });
    const bare = mkdtempSync(join(tmpdir(), 'pariksha-masked-bare-'));
    const outside = cli(['--root', bare]);
    assert.equal(outside.code, 2);
    assert.match(outside.err.join('\n'), /^pariksha masked-exit-codes: .*nothing was checked, so this is not a pass$/s);
  });
});

describe('masked-exit-codes: the config', () => {
  it('takes the defaults for absent keys', () => {
    assert.deepEqual(parseMaskedConfig('{}'), DEFAULT_MASKED_CONFIG);
  });

  it('reads every key', () => {
    assert.deepEqual(parseMaskedConfig(PRODUCT_JSON), PRODUCT);
  });

  const bad: Array<[string, RegExp]> = [
    ['not json', /not JSON: /],
    ['[]', /must be a JSON object/],
    ['{"gate": []}', /unknown key "gate"/],
    ['{"id": ""}', /"id" must be a non-empty string/],
    ['{"id": 1}', /"id" must be a non-empty string/],
    ['{"gateCommands": []}', /names no command/],
    ['{"gateCommands": [""]}', /"gateCommands" must be a list of commands/],
    ['{"gateCommands": "eslint"}', /"gateCommands" must be a list of commands/],
    ['{"hookDirs": [1]}', /"hookDirs" must be a list of path prefixes/],
    ['{"pipefailScope": ["("]}', /"pipefailScope" holds a bad regex/],
  ];
  for (const [text, message] of bad) {
    it(`refuses ${text}`, () => {
      assert.throws(() => parseMaskedConfig(text), message);
    });
  }

  it('formats a clean run, a refusal and an empty lookup', () => {
    assert.deepEqual(formatMasked([], 3, 'X'), { ok: true, out: ['✅ X: no masked exit codes (3 shell file(s) scanned)'], err: [] });
    assert.equal(formatMasked([], 0, 'X').ok, false);
    assert.equal(formatMasked([{ file: 'a.sh', line: 1, snippet: 's', reason: 'r' }], 1, 'X').err.length, 5);
  });
});

// Spellings an adversarial corpus and its bash differential found this check
// missing.
describe('masks the corpus found', () => {
  const masked = (line: string): number => {
    const { root, names } = fixture({ 'gate.sh': `#!/bin/bash\n${line}\n` });
    return find(root, names).length;
  };

  const reported: Array<[string, string]> = [
    ['an assignment prefix', 'X=1 eslint . || true'],
    ['a line that starts with echo', 'echo start; eslint . || true'],
    ['eval', "eval 'eslint . || true'"],
    ['bash -c', "bash -c 'eslint . || true'"],
    ['bash -e -c with a name', "bash -e -c 'eslint . || true' gate"],
    ['eval of joined words', "eval eslint . '||' true"],
    ['a pipe into sh', "printf '%s\\n' 'eslint . || true' | sh"],
    ['nested quoting', "bash -c 'eval '\\''eslint . || true'\\'''"],
    ['an echo handler', 'eslint . || echo failed'],
    ['an exit in a pipeline subshell', 'eslint . || exit 1 | cat'],
    ['an exit in a background subshell', 'eslint . || exit 1 &'],
    ['a brace handler that exits 0', 'eslint . || { echo failed; exit 0; }'],
    ['a brace handler piped into a subshell', 'eslint . || { echo failed; exit 1; } | cat'],
    ['a backgrounded brace handler', 'eslint . || { echo failed; exit 1; } &'],
    ["another list's exit", 'eslint . || echo failed; true || exit 1'],
    ["another list's exit after a lone &", 'eslint . || :& true || exit 1'],
    ['a discarded stderr beside an unrelated exit', 'eslint . 2>/dev/null; true || exit 1'],
    ['a quoted exit 0', "eslint . || exit '0'"],
    ['an exit of an unknown variable', 'eslint . || exit "$code"'],
    ['an exit of the status after another command', 'eslint . || { echo failed; exit $?; }'],
    ['a brace exit of a variable not set from the status', 'eslint . || { status=1; status=0; exit "$status"; }'],
    ['echo piped into sh', "echo 'eslint . || true' | sh"],
    ['a saved status overwritten before the exit', 'eslint . || { status=$?; status=0; exit "$status"; }'],
    ["a status saved after another command, which holds that command's", 'eslint . || { echo failed; status=$?; exit "$status"; }'],
    ['an exit behind a handler that succeeds', 'eslint . || echo failed || exit 1'],
    ['a brace exit behind a handler that succeeds', 'eslint . || echo failed || { exit 1; }'],
    ['a gate with its own handler after a fallback', 'grep -q x f || eslint . || true'],
    ['a masked gate after a propagating one', 'eslint . || exit 1; tsc --noEmit || true'],
    ['a discarded stderr kept failing by false', 'eslint . 2>/dev/null || false'],
    // echo prints `exit 1`; it runs no exit.
    ['an exit word echoed in a brace handler', 'eslint . || { echo failed; echo exit 1; }'],
    ['an exit word as an argument', 'eslint . || { echo exit 1; }'],
    ['a fallback after a false handler', 'eslint . || false || echo ok'],
    ['a true after a false handler', 'eslint . || false || true'],
  ];
  for (const [label, line] of reported) {
    it(`reports ${label}`, () => {
      assert.equal(masked(line), 1);
    });
  }

  const alone: Array<[string, string]> = [
    ['an exit that ends the command', 'eslint . || exit 1'],
    ['an exit of the status', 'eslint . || exit $?'],
    ['an exit of the quoted status', 'eslint . || exit "$?"'],
    ['a bare exit', 'eslint . || exit'],
    ['a brace handler that exits 1', 'eslint . || { echo failed; exit 1; }'],
    ['an exit with a redirection', 'eslint . || exit 1 2>&1'],
    ['an exit with a file redirection', 'eslint . || exit 1 >/dev/null'],
    ['an exit before another list', 'eslint . || exit 1; echo next'],
    ['an echoed mention', "echo 'eslint . || true'"],
    ['eval of text that runs no gate', "eval 'grep -q x f || true'"],
    ['eval as an argument', "echo eval 'eslint . || true'"],
    ['sh -c as an argument', "printf '%s' sh -c 'eslint . || true'"],
    ['a shell that runs a file', "bash run.sh 'eslint . || true'"],
    ['an unrelated list masked', 'eslint . || exit 1; grep -q x f || true'],
    ["bash -c's positional arguments", "bash -c 'printf %s \"$1\"' _ 'eslint . || true'"],
    ['quoted text outside the pipeline a shell reads', "echo 'eslint . || true'; printf '%s\\n' ':' | sh"],
    ['a quoted exit status', "eslint . || exit '1'"],
    ['a double-quoted exit status', 'eslint . || exit "2"'],
    ['a brace exit of the saved status', 'eslint . || { status=$?; echo failed; exit "$status"; }'],
    ['a brace exit of the status first', 'eslint . || { exit $?; }'],
    ['an exit after a false handler', 'eslint . || false || exit 1'],
    ['an exit after a guarded command', 'eslint . && echo ok || exit 1'],
    ['an inner handler inside the brace group', 'eslint . || { grep -q x f || true; exit 1; }'],
    ['a status saved with a space before the next command', 'eslint . || { rc=$? ; echo failed; exit $rc; }'],
    ['a filter between the text and the shell', "printf '%s\\n' 'eslint . || true' | grep -v eslint | sh"],
    ['a shell reading a file through a pipe', "cat 'gate list' | sh"],
    ['a shell with no pipe', 'sh'],
    ['a gate run as the fallback', "grep -q '^unchanged$' state || eslint ."],
    ['a fallback gate that propagates', 'grep -q x f 2>/dev/null || eslint . || exit 1'],
    ['a fallback gate whose exit redirects', 'grep -q x file || eslint . || exit 1 2>&1'],
    ['two gates that both propagate', 'eslint . || exit 1; tsc || exit 1'],
    ['a brace exit with no space after the semicolon', 'eslint . || { echo failed;exit 1; }'],
  ];
  for (const [label, line] of alone) {
    it(`leaves ${label} alone`, () => {
      assert.equal(masked(line), 0);
    });
  }
});

describe('which scripts a shell runs', () => {
  const masked = (text: string): number => {
    const { root, names } = fixture({ 'gate.sh': `#!/bin/bash\n${text}\n` });
    return find(root, names).length;
  };
  /** POSIX single quotes around `text`. */
  const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
  /** `eslint . || true` under `depth` evals, each quoting the next. */
  const evals = (depth: number): string => (depth === 0 ? 'eslint . || true' : `eval ${quote(evals(depth - 1))}`);
  /** An eval of `eslint . || true` under `depth` command substitutions. */
  const substitutions = (depth: number): string => (depth === 0 ? "eval 'eslint . || true'" : `echo $(${substitutions(depth - 1)})`);

  const reported: Array<[string, string]> = [
    ['a subshell', "( eval 'eslint . || true' )"],
    ['a subshell glued to its command', "(eval 'eslint . || true')"],
    ['an if condition', "if eval 'eslint . || true'; then :; fi"],
    ['a then branch', "if true; then eval 'eslint . || true'; fi"],
    ['a while condition', "while eval 'eslint . || true'; do :; done"],
    ['a loop body', "while false; do eval 'eslint . || true'; done"],
    ['an until condition', "until eval 'eslint . || true'; do :; done"],
    ['an elif condition', "if false; then :; elif eval 'eslint . || true'; then :; fi"],
    ['an else branch', "if false; then :; else eval 'eslint . || true'; fi"],
    ['a negation', "! eval 'eslint . || true'"],
    ['a brace group', "{ eval 'eslint . || true'; }"],
    ['time', "time eval 'eslint . || true'"],
    ['exec', "exec bash -c 'eslint . || true'"],
    ['command', "command eval 'eslint . || true'"],
    ['builtin', "builtin eval 'eslint . || true'"],
    ['nohup', "nohup bash -c 'eslint . || true'"],
    ['env', "env bash -c 'eslint . || true'"],
    ['a quoted command word', "'eval' 'eslint . || true'"],
    ['a shell by its path', "/bin/bash -c 'eslint . || true'"],
    ['an option with a value', "bash -o pipefail -c 'eslint . || true'"],
    ['printf after --', "printf -- '%s\\n' 'eslint . || true' | sh"],
    ['an argument filling the format', "printf 'eslint . %s\\n' '|| true' | sh"],
    ['a newline escape', "printf 'true\\neslint . || true\\n' | sh"],
    ['a tab escape', "printf 'eslint\\t. || true\\n' | sh"],
    ['a missing argument', "printf '%seslint . || true\\n' | sh"],
    ['escapes in a %b argument', "printf '%b' 'true\\neslint . || true' | sh"],
    ['a reused format', "printf '%s\\n' true 'eslint . || true' | sh"],
    ['echo joining its words', "echo 'eslint' '.' '||' 'true' | sh"],
    ['printf by its path', "/usr/bin/printf '%s\\n' 'eslint . || true' | sh"],
    ['a quoted printf', "'printf' '%s\\n' 'eslint . || true' | sh"],
    ['four evals deep', evals(4)],
    ['three substitutions deep', substitutions(3)],
    // printf decodes `\x7c` to `|` before sh reads it.
    ['a %b hex escape', "printf '%b\\n' 'eslint . \\x7c\\x7c true' | sh"],
    ['a %b octal escape', "printf '%b' 'eslint . \\0174\\0174 true' | sh"],
    ['a hex escape in the format', "printf 'eslint . \\x7c\\x7c true' | sh"],
    ['an octal escape in the format', "printf 'eslint . \\174| true' | sh"],
    ['a \\c in the format, which printf writes', "printf 'eslint . \\c|| true' | sh"],
    ['echo -e', "echo -e 'eslint . \\x7c\\x7c true' | sh"],
    ['echo with options', "echo -n -E 'eslint . || true' | sh"],
    ["an echo that sh's own echo decodes", "echo 'eslint . \\x7c| true' | sh"],
    // echo reads octal as `\0NNN`, as a `%b` argument does, not as the format.
    ['an echo octal escape', "echo 'eslint . \\0174\\0174 true' | sh"],
  ];
  for (const [label, text] of reported) {
    it(`reports a gate masked in ${label}`, () => {
      assert.equal(masked(text), 1);
    });
  }

  const none: Array<[string, string]> = [
    ['a script file before -c', "bash run.sh -c 'eslint . || true'"],
    ['a shell without -c', "bash -e 'eslint . || true'"],
    ['a +c option', "bash +c 'eslint . || true'"],
    ['a format this reader cannot render', "printf 'eslint . %s%d\\n' '|| true' | sh"],
    ['a stage with no command', 'X=1 | sh'],
    ['a stage that reads a file', "cat 'eslint . || true' | sh"],
    // `\\` writes `\`, which then escapes the `;`.
    ['an escaped backslash', "printf 'true\\\\;eslint . || true' | sh"],
    ['a literal percent', "printf '%%eslint . || true' | sh"],
    ['a %s argument, unescaped', "printf '%s' 'true\\neslint . || true' | sh"],
    ['five evals deep', evals(5)],
    ['four substitutions deep', substitutions(4)],
    ['a %b argument cut by \\c', "printf '%b' 'true\\c; eslint . || true' | sh"],
    ['the format after a \\c, which printf never writes', "printf '%b%s\\n' 'true\\c' 'eslint . || true' | sh"],
    ['an echo that writes nothing', 'echo -n | sh'],
    // A \c ends echo's output as it ends a %b argument's.
    ['an echo cut by \\c', "echo 'true\\c; eslint . \\x7c\\x7c true' | sh"],
  ];
  for (const [label, text] of none) {
    it(`reads no masked gate in ${label}`, () => {
      assert.equal(masked(text), 0);
    });
  }

  it('reads the line itself first, then each script it runs', () => {
    assert.deepEqual(executedTexts("eval 'a || b'"), ["eval 'a || b'", 'a || b']);
    assert.deepEqual(executedTexts('printf | sh'), ['printf | sh']);
  });
});

describe('what printf writes', () => {
  const cases: Array<[string, string[], string | null]> = [
    ['the named escapes in the format', ['\\a\\b\\e\\E\\f\\n\\r\\t\\v\\\\'], '\u0007\b\u001b\u001b\f\n\r\t\v\\'],
    ['the named escapes in a %b argument', ['%b', '\\a\\b\\e\\E\\f\\n\\r\\t\\v\\\\'], '\u0007\b\u001b\u001b\f\n\r\t\v\\'],
    ['a quote or ? escaped in the format', [`\\"\\'\\?`], `"'?`],
    ['a quote or ? escaped in a %b argument', ['%b', `\\"\\'\\?`], `\\"\\'\\?`],
    ['an unknown escape in the format', ['\\q'], '\\q'],
    // Octal is three digits at most in the format, `\0` and three in %b.
    ['octal in the format', ['\\0101'], '\b1'],
    ['octal in a %b argument', ['%b', '\\0101'], 'A'],
    ['the last code point', ['\\U0010FFFF'], '\u{10FFFF}'],
    ['a code point past Unicode, as written', ['\\U00110000'], '\\U00110000'],
    ['a %b with no argument left', ['<%b>'], '<>'],
    ['nothing after a \\c in a %b argument', ['%b%s', 'a\\cb', 'c'], 'a'],
    ['no format at all', [], null],
    ['a directive this reader does not render', ['%d'], null],
    ['a literal percent', ['%%'], '%'],
  ];
  for (const [label, words, written] of cases) {
    it(label, () => {
      assert.equal(renderPrintf(words), written);
    });
  }
});

describe('what a masked gate reports', () => {
  const verdicts = (text: string): string[] => {
    const { root, names } = fixture({ 'gate.sh': `#!/bin/bash\n${text}\n` });
    return find(root, names).map(({ reason }) => (/discards/.test(reason) ? 'discards' : /does not exit/.test(reason) ? 'handler' : /stderr/.test(reason) ? 'stderr' : reason));
  };

  const cases: Array<[string, string[]]> = [
    // One report per line: the script it runs is not judged again.
    ['eslint . || true; eval ' + "'tsc || true'", ['discards']],
    ['eslint . || echo failed; eval ' + "'tsc || true'", ['handler']],
    ['eslint . 2>/dev/null; eval ' + "'tsc || true'", ['stderr']],
    // An exempt capture still leaves the scripts on its line to judge.
    ['OUT=$(eslint . || true); eval \'tsc || true\'\nif [ -n "$OUT" ]; then exit 1; fi', ['discards']],
    // The gate's own handler, not an earlier mention's.
    ['echo eslint . || eslint . || true', ['discards']],
    ['eslint . || exit "$?', ['handler']],
    ['eslint . 2>/dev/null; status=$?', []],
  ];
  for (const [text, expected] of cases) {
    it(`${JSON.stringify(text)} reports ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(verdicts(text), expected);
    });
  }
});

describe('a status saved for a later line', () => {
  const masked = (text: string): number => {
    const { root, names } = fixture({ 'gate.sh': `#!/bin/bash\neslint . || rc=$?\n${text}\n` });
    return find(root, names).length;
  };

  const reported: Array<[string, string]> = [
    ['an exit that never reads it', 'exit 1'],
    ['a test of another variable', '[ "$rc" ] && [ "$x" -ne 0 ] && exit "$rc"'],
    ['a test against another number', '[ "$rc" -ne 1 ] && exit "$rc"'],
    ['an exit in the else of a failure test', 'if [ "$rc" -ne 0 ]; then :; else exit "$rc"; fi'],
    ['an exit after a list that tests it', '[ "$rc" -ne 0 ] && echo bad\nexit 1'],
    ['an exit on the success branch', 'if [ "$rc" -eq 0 ]; then\n  exit 1\nfi'],
    ['an exit in the else of a failure branch', 'if [ "$rc" -ne 0 ]; then\n  :\nelse\n  exit 1\nfi'],
    ['a reassignment before the exit', 'if [ "$rc" -ne 0 ]; then\n  rc=0\n  exit "$rc"\nfi'],
  ];
  for (const [label, text] of reported) {
    it(`reports ${label}`, () => {
      assert.equal(masked(text), 1);
    });
  }

  const alone: Array<[string, string]> = [
    ['an unconditional exit of it', 'exit "${rc:-0}"'],
    ['an exit under a failure test', '[ "$rc" -ne 0 ] && exit "$rc"'],
    ['an exit in a failure branch', 'if [ "$rc" -ne 0 ]; then\n  exit "$rc"\nfi'],
    ['an exit in the else of a success branch', 'if [ "$rc" -eq 0 ]; then\n  :\nelse\n  exit "$rc"\nfi'],
    // The branch decides even when its exit names a number, not the status.
    ['an exit 1 in a failure branch', 'if [ "$rc" -ne 0 ]; then\n  exit 1\nfi'],
    ['an exit 1 in the else of a success branch', 'if [ "$rc" -eq 0 ]; then\n  :\nelse\n  exit 1\nfi'],
  ];
  for (const [label, text] of alone) {
    it(`leaves ${label} alone`, () => {
      assert.equal(masked(text), 0);
    });
  }
});
