import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkHookPreamble as judge, DEFAULT_RUNTIMES, isBefore, type PreambleConfig } from './hook-preamble.ts';
import type { ShellSource } from './shell-sources.ts';

/**
 * hook-preamble: the .husky hook preamble. Fixtures are inline hook texts
 * judged as `.husky/<name>`; each rule has a violating case, the corrected
 * hook, and a near miss. The config is a product's: its id, its select
 * script and the function that script defines.
 */

const PREAMBLE: PreambleConfig = {
  id: 'SHELL-06',
  hooksDir: '.husky/',
  selectScript: 'scripts/lib/select-node.sh',
  selectFunction: 'select_node',
  runtimes: DEFAULT_RUNTIMES,
};
const checkHookPreamble = (source: ShellSource) => judge(source, PREAMBLE);

/** vitest's `it.each`: an array row is spread into the test; `%s` takes the row's values in order. */
const each =
  <T,>(rows: readonly T[]) =>
  (name: string, fn: (...args: T extends readonly unknown[] ? T : [T]) => void): void => {
    for (const row of rows) {
      const args = (Array.isArray(row) ? row : [row]) as unknown[];
      let n = 0;
      it(
        name.replace(/%s/g, () => String(args[n++])),
        () => fn(...(args as unknown as T extends readonly unknown[] ? T : [T])),
      );
    }
  };

const SELECT = [
  '# shellcheck source=../scripts/lib/select-node.sh',
  '. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/scripts/lib/select-node.sh"',
  'select_node || exit 1',
].join('\n');

const hook = (...lines: string[]) =>
  `#!/usr/bin/env bash\n${lines.join('\n')}\n`;

const rulesHit = (text: string, path = '.husky/pre-commit') =>
  checkHookPreamble({ path, text }).map(finding => finding.rule);

describe('SHELL-06 hook preamble', () => {
  // The catalogue example: a post-commit hook ran `node` from whatever PATH
  // held, skipping the repo's pinned runtime. The reviewed hook body,
  // comments dropped.
  const catalogueExample = hook(
    'if command -v node >/dev/null 2>&1; then',
    '  NODE_NO_WARNINGS=1 node "$(dirname "$0")/../scripts/lib/hook-step.ts" run || true',
    'fi',
    'exit 0',
  );

  it('fails the catalogue example: node before select-node.sh', () => {
    assert.deepEqual(checkHookPreamble({ path: '.husky/pre-commit', text: catalogueExample }).map(({ check, rule, file, line }) => ({ check, rule, file, line })), [
      {
        check: 'SHELL-06',
        rule: 'runtime-before-select-node',
        file: '.husky/pre-commit',
        line: 3,
      },
    ]);
  });

  it('passes the corrected hook: opt-out, then selection, then node', () => {
    const fixed = hook(
      '[ "${PROJ_POST_COMMIT_PREFLIGHT:-}" = "0" ] && exit 0',
      SELECT.replace(
        'select_node || exit 1',
        'if select_node; then',
      ),
      '  NODE_NO_WARNINGS=1 node scripts/lib/hook-step.ts run || true',
      'fi',
      'exit 0',
    );
    assert.deepEqual(rulesHit(fixed), []);
  });

  it('fails a runtime run inside a quoted command substitution', () => {
    assert.deepEqual(rulesHit(hook('VERSION="$(node --version)"')), [
      'runtime-before-select-node',
    ]);
  });

  it('fails when the library is sourced but select_node is never called', () => {
    const text = hook(
      SELECT.replace('select_node || exit 1', ''),
      'pnpm exec tsc',
    );
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
  });

  it('fails when select_node is called with the library never sourced', () => {
    assert.deepEqual(rulesHit(
        hook('select_node || exit 1', 'npx commitlint --edit "$1"'),
      ), ['runtime-before-select-node']);
  });

  it('near miss: a runtime named only in an echo or a comment is no call', () => {
    assert.deepEqual(rulesHit(hook('# node runs later', 'echo "run pnpm install first"')), []);
  });

  it('near miss: a hook that never runs a Node tool needs no selection', () => {
    assert.deepEqual(rulesHit(hook('git diff --cached --quiet && exit 0')), []);
  });

  it('fails an opt-out placed after runtime selection', () => {
    const text = hook(
      SELECT,
      '[ "${PROJ_SKIP_HOOK:-}" = "1" ] && exit 0',
      'pnpm lint',
    );
    assert.deepEqual(rulesHit(text), ['opt-out-after-select-node']);
  });

  it('fails an if/then opt-out placed after runtime selection', () => {
    const text = hook(
      SELECT,
      'if [ "$SKIP_CHECKS" = "1" ]; then exit 0; fi',
      'pnpm lint',
    );
    assert.deepEqual(rulesHit(text), ['opt-out-after-select-node']);
  });

  it('near miss: an early exit on a lower-case local is control flow, not an opt-out', () => {
    const text = hook(
      SELECT,
      'if [ -z "$commit_msg" ]; then exit 0; fi',
      'pnpm lint',
    );
    assert.deepEqual(rulesHit(text), []);
  });

  each([
    ['a PATH edit', 'export PATH="$HOME/bin:$PATH"'],
    ['NVM_DIR', 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"'],
    ['nvm.sh', '. "$HOME/.nvm/nvm.sh"'],
    ['nvm use', 'nvm use'],
    ['fnm use', 'fnm use --silent-if-unchanged'],
    ['fnm env', 'eval "$(fnm env)"'],
    ['mise activate', 'eval "$(mise activate bash)"'],
    ['mise env', 'eval "$(mise env -s bash)"'],
    ['mise exec', 'mise exec -- node -v'],
    ['mise x', 'mise x node -- node -v'],
  ])('fails %s in the hook itself (own-runtime-path)', (_label, line) => {
    assert.ok((rulesHit(hook(SELECT, line))).includes('own-runtime-path'));
  });

  it('near miss: append_tool_paths, a PATH read and a message are not edits', () => {
    assert.deepEqual(rulesHit(
        hook(
          SELECT,
          'append_tool_paths',
          'echo "PATH is $PATH"',
          'echo "run: fnm use"',
          'echo "run: mise install"',
          'mise install',
        ),
      ), []);
  });

  it('fails an exec sh trampoline and passes exec of the hook itself', () => {
    assert.deepEqual(rulesHit(hook('exec sh .husky/pre-push "$@"')), [
      'exec-sh-trampoline',
    ]);
    assert.deepEqual(rulesHit(hook('exec "$(dirname "$0")/pre-push" "$@"')), []);
    // bash names the dialect the hook is written in; only sh/dash override it.
    assert.deepEqual(rulesHit(hook('exec bash .husky/pre-push "$@"')), []);
    assert.deepEqual(rulesHit(hook('exec /bin/dash .husky/pre-push')), [
      'exec-sh-trampoline',
    ]);
  });

  it('checks a multi-line inline trap handler as a whole', () => {
    const returns = hook("trap '", '  rm -f "$LOCK"', "' INT TERM");
    assert.deepEqual(rulesHit(returns), ['signal-trap-continues']);
    const exits = hook("trap '", '  rm -f "$LOCK"', '  exit 130', "' INT TERM");
    assert.deepEqual(rulesHit(exits), []);
  });

  it('fails a runtime inside a multi-line double-quoted string', () => {
    assert.deepEqual(rulesHit(hook('MSG="node is', '$(node --version)', '"')), [
      'runtime-before-select-node',
    ]);
  });

  it('does not count selection inside a function that may never run', () => {
    const uncalled = hook(
      'select_runtime() {',
      '  . "$ROOT/scripts/lib/select-node.sh"',
      '  select_node || exit 1',
      '}',
      'node x.js',
    );
    assert.deepEqual(rulesHit(uncalled), ['runtime-before-select-node']);
    const oneLine = hook(
      'pick() { . "$ROOT/scripts/lib/select-node.sh"; select_node; }',
      'node x.js',
    );
    assert.deepEqual(rulesHit(oneLine), ['runtime-before-select-node']);
  });

  it('judges a runtime in a function where the function is called', () => {
    const defineFirst = [
      'run_checks() {',
      '  node x.js',
      '}',
      'lint() { run_checks; }',
    ];
    assert.deepEqual(rulesHit(hook(...defineFirst, SELECT, 'lint')), []);
    const callFirst = hook(...defineFirst, 'lint', SELECT);
    assert.deepEqual(checkHookPreamble({ path: '.husky/pre-push', text: callFirst }).map(({ rule, line }) => ({ rule, line })), [
      {
        rule: 'runtime-before-select-node',
        line: 6,
      },
    ]);
  });

  it('does not count selection made in a subshell', () => {
    const inline = hook(
      '( . "$ROOT/scripts/lib/select-node.sh"; select_node )',
      'node x.js',
    );
    assert.deepEqual(rulesHit(inline), ['runtime-before-select-node']);
    const block = hook(
      '(',
      '  . "$ROOT/scripts/lib/select-node.sh"',
      '  select_node',
      ')',
      'node x.js',
    );
    assert.deepEqual(rulesHit(block), ['runtime-before-select-node']);
    assert.deepEqual(rulesHit(hook('V="$(select_node)"', SELECT, 'node x')), []);
  });

  it('counts selection only when its failure stops the hook', () => {
    const load = '. "$ROOT/scripts/lib/select-node.sh"';
    assert.deepEqual(rulesHit(hook(load, 'select_node || true', 'node x.js')), ['runtime-before-select-node']);
    assert.deepEqual(rulesHit(hook(load, 'select_node', 'node x.js')), [
      'runtime-before-select-node',
    ]);
    assert.deepEqual(rulesHit(
        hook(load, 'if ! select_node; then exit 1; fi', 'node x.js'),
      ), []);
    assert.deepEqual(rulesHit(hook(load, 'select_node || { echo no; exit 1; }', 'node')), []);
    assert.deepEqual(rulesHit(hook(load, 'select_node || { echo "no node"; }', 'node')), ['runtime-before-select-node']);
  });

  it('does not count selection in a pipeline stage, which is a subshell', () => {
    const text = hook(
      '. "$ROOT/scripts/lib/select-node.sh"',
      'printf x | select_node || exit 1',
      'node x.js',
    );
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
  });

  it('removes a backslash-newline inside double quotes, as bash does', () => {
    assert.deepEqual(rulesHit(hook('VERSION="$(no\\', 'de --version)"')), [
      'runtime-before-select-node',
    ]);
  });

  it('carries nested quoting across lines: an inner close is not the outer one', () => {
    // `"$(printf "%s` + `" x) node is text"` is one string; the next line is code.
    const text = hook('MSG="$(printf "%s', '" x) node is text"', 'pnpm lint');
    assert.deepEqual(checkHookPreamble({ path: '.husky/pre-commit', text }).map(finding => [
        finding.rule,
        finding.line,
      ]), [['runtime-before-select-node', 4]]);
  });

  it('near miss: quoted text outside a message names a PATH or nvm edit without making one', () => {
    assert.deepEqual(rulesHit(
        hook(
          SELECT,
          'HELP="export PATH=/opt/x:$PATH; nvm use; fnm env"',
          "NOTE='source ~/.nvm/nvm.sh; export NVM_DIR=x'",
        ),
      ), []);
  });

  each([
    ['\\. "$NVM_DIR/nvm.sh"'],
    ['source ~/.nvm/nvm.sh'],
    ['. "$HOME/.nvm/nvm.sh" --no-use'],
  ])('fails sourcing nvm through a quoted or bare path: %s', line => {
    assert.deepEqual(rulesHit(hook(SELECT, line)), ['own-runtime-path']);
  });

  each([
    [['if [ "$SKIP_CHECKS" = "1" ]; then', '  exit 0', 'fi']],
    [['if [ "$SKIP_CHECKS" = "1" ]', 'then', '  exit 0', 'fi']],
    [['[ "${PROJ_SKIP_HOOK:-}" = "1" ] &&', '  exit 0']],
  ])('fails a multi-line opt-out placed after runtime selection', optOut => {
    const text = hook(SELECT, ...optOut, 'pnpm lint');
    assert.deepEqual(checkHookPreamble({ path: '.husky/pre-commit', text }).map(finding => [
        finding.rule,
        finding.line,
      ]), [['opt-out-after-select-node', 5]]);
  });

  it('near miss: a multi-line if on an upper-case variable that does not exit 0', () => {
    const text = hook(
      SELECT,
      'if [ "$SKIP_CHECKS" = "1" ]; then',
      '  echo skipping lint',
      'fi',
      'exit 0',
    );
    assert.deepEqual(rulesHit(text), []);
  });

  it('passes an exit whose output is redirected: it still exits the hook', () => {
    assert.deepEqual(rulesHit(
        hook(
          SELECT.replace('|| exit 1', '|| exit 1 >&2'),
          "trap 'cleanup; exit 130 >&2' INT",
          'stop() { cleanup; exit 143 2>/dev/null; }',
          'trap stop TERM',
          'pnpm lint',
        ),
      ), []);
    assert.deepEqual(rulesHit(
        hook(
          SELECT.replace('|| exit 1', '|| { echo no; exit 1 >&2; }'),
          'pnpm lint',
        ),
      ), []);
  });

  it('reads a # inside a nested substitution string as text, not a comment', () => {
    const text = hook('LABEL="$(printf "%s" " #")"', 'pnpm lint');
    assert.deepEqual(checkHookPreamble({ path: '.husky/pre-commit', text }).map(finding => [
        finding.rule,
        finding.line,
      ]), [['runtime-before-select-node', 3]]);
  });

  it('fails when select-node.sh is only printed, never sourced', () => {
    const text = hook(
      `echo ' . "$ROOT/scripts/lib/select-node.sh"'`,
      'echo source scripts/lib/select-node.sh',
      'select_node || exit 1',
      'pnpm lint',
    );
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
  });

  each([
    ['. scripts/lib/select-node.sh'],
    ['source "./scripts/lib/select-node.sh"'],
  ])('passes a repository-relative source: %s', line => {
    assert.deepEqual(rulesHit(hook(line, 'select_node || exit 1', 'pnpm lint')), []);
  });

  it('near miss: an opt-out before selection, after an uncalled function that sources it', () => {
    const text = hook(
      'reselect() { . scripts/lib/select-node.sh; }',
      '[ "${PROJ_SKIP_HOOK:-}" = "1" ] && exit 0',
      SELECT,
      'pnpm lint',
    );
    assert.deepEqual(rulesHit(text), []);
  });

  each([
    ['env -u NODE_OPTIONS node scripts/check.js'],
    ['git ls-files -z | xargs -0 -n 1 node scripts/check.js'],
    ['xargs -I {} node scripts/check.js {}'],
  ])('finds a runtime behind forwarder options with values: %s', line => {
    assert.deepEqual(rulesHit(hook(line)), ['runtime-before-select-node']);
  });

  it('masks strings inside a backtick substitution within double quotes', () => {
    assert.deepEqual(rulesHit(hook("MSG=\"`printf '%s' 'ok; node is text'`\"", 'echo "$MSG"')), []);
    assert.deepEqual(rulesHit(hook('V="`node --version`"')), [
      'runtime-before-select-node',
    ]);
  });

  it('near miss: an escaped separator inside a quoted backtick substitution', () => {
    assert.deepEqual(rulesHit(hook('MSG="`printf x\\; node is text`"')), []);
  });

  it('judges a backtick substitution spanning lines of an expanding heredoc', () => {
    const text = hook('cat <<EOF', 'Version: `', 'node --version`', 'EOF');
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
  });

  it('folds a backslash-newline inside an expanding heredoc substitution', () => {
    const text = hook('cat <<EOF', 'Version: $(no\\', 'de --version)', 'EOF');
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
  });

  it('near miss: a case label naming a runtime runs nothing', () => {
    const text = hook(
      'case "$1" in',
      '  node) echo "runtime: node" ;;',
      '  npm|pnpm)',
      '    echo "package manager" ;;',
      'esac',
    );
    assert.deepEqual(rulesHit(text), []);
    assert.deepEqual(rulesHit(hook('V="$(cd x; node --version)"')), [
      'runtime-before-select-node',
    ]);
    assert.deepEqual(rulesHit(hook('V=$(node)', '(cd x && pnpm)')), [
      'runtime-before-select-node',
    ]);
  });

  it('drops a comment inside a quoted multi-line substitution', () => {
    const text = hook(
      'VALUE="$(git rev-parse HEAD # node is not run here',
      ')"',
      'echo "$VALUE ${#VALUE}"',
    );
    assert.deepEqual(rulesHit(text), []);
    assert.deepEqual(rulesHit(hook('VALUE="$(git rev-parse HEAD # note', 'node x)"')), ['runtime-before-select-node']);
  });

  each([
    ['>/dev/null node x.js'],
    ['2>&1 node x.js'],
    ['< "$input file" node x.js'],
  ])('finds a runtime after a leading redirection: %s', line => {
    assert.deepEqual(rulesHit(hook(line)), ['runtime-before-select-node']);
  });

  it('reads case arms nested in a substitution', () => {
    assert.deepEqual(rulesHit(hook('V="$(case "$1" in lint) node x.js ;; esac)"')), ['runtime-before-select-node']);
    assert.deepEqual(rulesHit(hook('V="$(case "$1" in node) echo n ;; esac)"')), []);
    assert.deepEqual(rulesHit(hook('case "$1" in x) V=$(node -v) ;; esac')), [
      'runtime-before-select-node',
    ]);
  });

  it('reads the source list at its own level: a ; inside $(...) ends nothing', () => {
    assert.deepEqual(rulesHit(
        hook(
          '. scripts/lib/select-node.sh "$(printf x; printf y)" | cat',
          'select_node || exit 1',
          'pnpm lint',
        ),
      ), ['runtime-before-select-node']);
  });

  it('finds a runtime after a case label on the same line', () => {
    const text = hook(
      'case "$1" in',
      '  lint) node scripts/check.js ;;',
      'esac',
    );
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
    assert.deepEqual(rulesHit(hook('echo $(date) node is an argument')), []);
  });

  it('reads a function whose { opens the next line as a definition', () => {
    const text = hook(
      'run_lint()',
      '{',
      '  pnpm lint',
      '}',
      SELECT,
      'run_lint',
    );
    assert.deepEqual(rulesHit(text), []);
    assert.deepEqual(rulesHit(hook('run_lint()', '{', '  pnpm lint', '}', 'run_lint')), ['runtime-before-select-node']);
  });

  it('opens a heredoc on the code after a multi-line string closes', () => {
    const text = hook(
      "printf '%s' 'help",
      "'; cat <<'EOF'",
      'node is documented here, not run',
      'EOF',
    );
    assert.deepEqual(rulesHit(text), []);
  });

  it('fails an opt-out on the same line as the selector source', () => {
    const text = hook(
      '. scripts/lib/select-node.sh; select_node || exit 1; [ "$SKIP_CHECKS" = 1 ] && exit 0',
      'pnpm lint',
    );
    assert.deepEqual(rulesHit(text), ['opt-out-after-select-node']);
  });

  each([
    ['. scripts/lib/select-node.sh | cat'],
    ['. scripts/lib/select-node.sh &'],
    ['printf x | . scripts/lib/select-node.sh'],
  ])('fails a selector sourced in a child shell: %s', line => {
    assert.deepEqual(rulesHit(hook(line, 'select_node || exit 1', 'pnpm lint')), ['runtime-before-select-node']);
  });

  it('passes a selector sourced before an and-list whose later pipeline is its own', () => {
    assert.deepEqual(rulesHit(
        hook(
          '. scripts/lib/select-node.sh && select_node || exit 1',
          'pnpm lint | cat',
        ),
      ), []);
  });

  it('near miss: an opt-out quoted as an example exits nothing', () => {
    const text = hook(
      SELECT,
      `echo 'to skip: [ "$SKIP_CHECKS" = 1 ] && exit 0'`,
      `HELP='[ "$SKIP_CHECKS" = 1 ] && exit 0'`,
      'pnpm lint',
    );
    assert.deepEqual(rulesHit(text), []);
  });

  it('near miss: an escaped separator starts no command', () => {
    assert.deepEqual(rulesHit(hook('echo example\\; node is text \\| pnpm too')), []);
    assert.deepEqual(rulesHit(hook('echo example; node x')), [
      'runtime-before-select-node',
    ]);
  });

  it('splits a handler only at unquoted semicolons', () => {
    assert.deepEqual(rulesHit(hook('trap \'echo "stop; exit 1"\' INT')), [
      'signal-trap-continues',
    ]);
  });

  it('finds a runtime launched through env', () => {
    assert.deepEqual(rulesHit(hook('env NODE_NO_WARNINGS=1 node x.ts')), [
      'runtime-before-select-node',
    ]);
  });

  it('near miss: a message inside an if names no runtime change', () => {
    assert.deepEqual(rulesHit(
        hook(
          SELECT,
          'if ! command -v fnm >/dev/null; then echo "run fnm use"; fi',
          'if [ -z "$X" ]; then echo export PATH=/x; fi',
        ),
      ), []);
  });

  it('does not accept an exit that only leaves a pipeline child', () => {
    const text = hook(
      '. "$ROOT/scripts/lib/select-node.sh"',
      'select_node || exit 1 | cat',
      'node x.js',
    );
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
    assert.deepEqual(rulesHit(hook(SELECT, 'node>out.log')), []);
    assert.deepEqual(rulesHit(hook('node>out.log', SELECT)), [
      'runtime-before-select-node',
    ]);
  });

  it('does not count selection sent to the background', () => {
    const text = hook(
      '. "$ROOT/scripts/lib/select-node.sh"',
      'select_node || exit 1 &',
      'node x.js',
    );
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
    const redirected = hook(
      '. "$ROOT/scripts/lib/select-node.sh"',
      'select_node 2>&1 || exit 1',
      'node x.js',
    );
    assert.deepEqual(rulesHit(redirected), []);
  });

  it('fails a handler whose exit runs in a child shell', () => {
    assert.deepEqual(rulesHit(hook("trap 'cleanup; exit 130 &' INT TERM")), [
      'signal-trap-continues',
    ]);
    assert.deepEqual(rulesHit(hook("trap 'cleanup; exit 130 | cat' INT")), [
      'signal-trap-continues',
    ]);
    assert.deepEqual(rulesHit(hook('on_stop() { rm -f x; exit 130 & }', 'trap on_stop INT')), ['signal-trap-continues']);
    assert.deepEqual(rulesHit(hook('trap \'exit "$code"\' INT')), []);
  });

  it('joins a continued word as bash does, with nothing between', () => {
    assert.deepEqual(rulesHit(hook('no\\', 'de scripts/check.js')), [
      'runtime-before-select-node',
    ]);
  });

  it('does not count selection after `|&`, a pipeline too', () => {
    const text = hook(
      '. "$ROOT/scripts/lib/select-node.sh"',
      'printf x |& select_node || exit 1',
      'node x.js',
    );
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
  });

  it('near miss: an unquoted message naming a PATH edit makes none', () => {
    assert.deepEqual(rulesHit(hook(SELECT, 'echo export PATH=/opt/x:$PATH')), []);
    assert.deepEqual(rulesHit(hook(SELECT, 'echo hi; export PATH=/opt/x:$PATH')), ['own-runtime-path']);
  });

  it('checks every trap on a line', () => {
    assert.deepEqual(rulesHit(hook("trap 'exit 130' INT; trap '' TERM")), [
      'signal-trap-continues',
    ]);
  });

  it('finds a runtime whose name is quoted', () => {
    assert.deepEqual(rulesHit(hook('"node" x.js')), [
      'runtime-before-select-node',
    ]);
    assert.deepEqual(rulesHit(hook("X='node'", '[ "$X" = "node" ]')), []);
  });

  it('does not accept a top-level `|| return`, which fails and carries on', () => {
    const text = hook(
      '. "$ROOT/scripts/lib/select-node.sh"',
      'select_node || return 1',
      'node x.js',
    );
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
  });

  it('judges code after a one-line function on the same line as top level', () => {
    assert.deepEqual(rulesHit(hook('noop() { :; }; node scripts/check.js')), [
      'runtime-before-select-node',
    ]);
    assert.deepEqual(rulesHit(hook('noop() { node x; }', SELECT)), []);
  });

  it('near miss: a reserved word used as an argument starts no command', () => {
    assert.deepEqual(rulesHit(hook('echo if node', 'echo then pnpm')), []);
  });

  it('does not count selection inside a backtick substitution', () => {
    const text = hook(
      'X=`. "$ROOT/scripts/lib/select-node.sh"; select_node || exit 1`',
      'node x.js',
    );
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
  });

  it('ends a function at its own closing brace, not a nested group', () => {
    const text = hook(
      'later() {',
      '  { echo start; }',
      '  . "$ROOT/scripts/lib/select-node.sh"',
      '  select_node || exit 1',
      '}',
      'node x.js',
    );
    assert.deepEqual(rulesHit(text), ['runtime-before-select-node']);
    const handler = hook(
      'on_stop() {',
      '  if [ -n "${LOCK}" ]; then { rm -f "$LOCK"; }; fi',
      '  exit 130',
      '}',
      'trap on_stop INT',
    );
    assert.deepEqual(rulesHit(handler), []);
  });

  it('near miss: a message naming `exec sh` is no trampoline', () => {
    assert.deepEqual(rulesHit(hook('echo "do not exec sh .husky/pre-push"')), []);
  });

  it('reads `function name { ... }` handlers like `name() { ... }`', () => {
    const exits = hook(
      'function on_stop {',
      '  rm -f "$LOCK"',
      '  exit 130',
      '}',
      'trap on_stop INT',
    );
    assert.deepEqual(rulesHit(exits), []);
    assert.deepEqual(rulesHit(hook('function on_stop { rm -f "$LOCK"; }', 'trap on_stop INT')), ['signal-trap-continues']);
  });

  it('fails an INT/TERM trap whose handler returns', () => {
    assert.deepEqual(rulesHit(hook('trap \'rm -f "$LOCK"\' INT TERM')), [
      'signal-trap-continues',
    ]);
  });

  it('fails a trap whose exit depends on the cleanup before it', () => {
    assert.deepEqual(rulesHit(hook("trap 'cleanup && exit 130' INT TERM")), [
      'signal-trap-continues',
    ]);
    const named = hook(
      'on_stop() {',
      '  cleanup && exit 130',
      '}',
      'trap on_stop INT',
    );
    assert.deepEqual(rulesHit(named), ['signal-trap-continues']);
    assert.deepEqual(rulesHit(hook("trap 'cleanup || true; exit 130' INT")), []);
  });

  it('accepts selection and the runtime in order on one line, and rejects the reverse', () => {
    const inOrder =
      '. "$ROOT/scripts/lib/select-node.sh"; select_node || exit 1; node x.js';
    assert.deepEqual(rulesHit(hook(inOrder)), []);
    const reversed =
      'node x.js; . "$ROOT/scripts/lib/select-node.sh"; select_node || exit 1';
    assert.deepEqual(rulesHit(hook(reversed)), ['runtime-before-select-node']);
  });

  it('passes a trap handler ending in exit, inline or in a named function', () => {
    assert.deepEqual(rulesHit(hook('trap \'rm -f "$LOCK"; exit 130\' INT TERM')), []);
    const named = hook(
      'on_stop() {',
      '  rm -f "$LOCK"',
      '  exit 130',
      '}',
      'trap on_stop INT TERM',
    );
    assert.deepEqual(rulesHit(named), []);
    assert.deepEqual(rulesHit(
        hook('on_stop() { rm -f "$LOCK"; exit 130; }', 'trap on_stop SIGINT'),
      ), []);
  });

  it('fails a named trap function that does not exit, or does not exist', () => {
    const returns = hook(
      'on_stop() {',
      '  rm -f "$LOCK"',
      '}',
      'trap on_stop TERM',
    );
    assert.deepEqual(rulesHit(returns), ['signal-trap-continues']);
    assert.deepEqual(rulesHit(hook('trap missing_handler INT')), [
      'signal-trap-continues',
    ]);
  });

  it('reads the handler after `trap --` and quoted or lower-case signals', () => {
    assert.deepEqual(rulesHit(hook("trap -- '' INT TERM")), [
      'signal-trap-continues',
    ]);
    assert.deepEqual(rulesHit(hook('trap -- cleanup "INT"')), [
      'signal-trap-continues',
    ]);
    assert.deepEqual(rulesHit(hook("trap 'rm -f x' sigterm")), [
      'signal-trap-continues',
    ]);
    assert.deepEqual(rulesHit(hook('trap -- - INT', 'trap -l')), []);
  });

  it('near miss: a message quoting a PATH or nvm edit makes none', () => {
    assert.deepEqual(rulesHit(
        hook(
          SELECT,
          "echo 'export PATH=/opt/x:$PATH'",
          'printf "%s\\n" "source ~/.nvm/nvm.sh"',
        ),
      ), []);
    assert.deepEqual(rulesHit(hook(SELECT, 'echo "$(fnm env)"')), [
      'own-runtime-path',
    ]);
  });

  it("fails an ignored signal: trap '' INT lets a cancelled hook run on", () => {
    assert.deepEqual(rulesHit(hook("trap '' INT TERM")), [
      'signal-trap-continues',
    ]);
    assert.deepEqual(rulesHit(hook('trap "" HUP')), ['signal-trap-continues']);
    assert.deepEqual(rulesHit(hook('trap - INT TERM')), []);
  });

  it('near miss: an EXIT trap, a reset and a list are not stop handlers', () => {
    assert.deepEqual(rulesHit(hook('trap \'rm -f "$LOCK"\' EXIT', 'trap - INT', 'trap -p')), []);
  });

  // The source suite judged its product's real hooks here; this package has
  // none, so each name gets a hook of the same shape (a runner trampoline,
  // then selection, then the tools). The real hooks are judged by the
  // parity run on that product's tree.
  each(['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push'])(
    'passes a hook shaped like the product\'s %s',
    name => {
      const path = `.husky/${name}`;
      const text = hook(
        '. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/scripts/lib/hook-runner.sh"',
        `run_hook ${name} "$@"`,
        '',
        SELECT,
        'append_tool_paths',
        '',
        'msg=$(sed \'/^#/d\' "$1")',
        'if grep -qE \'^(Merge|Revert)\' <<<"$msg"; then',
        '  exit 0',
        'fi',
        'npx commitlint --edit "$1" || exit 1',
        'pnpm exec tsx scripts/check.ts',
      );
      assert.deepEqual(checkHookPreamble({ path, text }), []);
    },
  );

  it('judges only direct .husky hooks, never scripts or husky internals', () => {
    assert.deepEqual(rulesHit(catalogueExample, 'scripts/tools/x.sh'), []);
    assert.deepEqual(rulesHit(catalogueExample, '.husky/_/pre-commit'), []);
    assert.deepEqual(rulesHit(catalogueExample, '.husky/README.md'), []);
  });
});

describe('SHELL-06 edges the mutation gate found unpinned', () => {
  const judged = (text: string) =>
    checkHookPreamble({ path: '.husky/pre-commit', text }).map(finding => [
      finding.rule,
      finding.line,
      finding.message,
    ]);

  it('says what each rule found, in line order', () => {
    assert.deepEqual(judged(
        hook(
          "trap 'echo bye' INT TERM",
          'node x',
          'export PATH="/opt/bin:$PATH"',
          'exec sh .husky/pre-push',
        ),
      ), [
      [
        'signal-trap-continues',
        2,
        "trap 'echo bye' on INT TERM does not end in exit: bash resumes after the handler, so a cancelled hook keeps running",
      ],
      [
        'runtime-before-select-node',
        3,
        'runs a Node tool before sourcing scripts/lib/select-node.sh and calling select_node, so it uses whatever node PATH happens to hold',
      ],
      [
        'own-runtime-path',
        4,
        'hook edits PATH or drives nvm/fnm/mise itself; scripts/lib/select-node.sh owns runtime and tool PATH',
      ],
      [
        'exec-sh-trampoline',
        5,
        '`exec sh <hook>` runs the target under sh whatever its shebang says; exec the hook itself',
      ],
    ]);
    assert.deepEqual(judged(hook(SELECT, '[ "$SKIP_HOOK" = 1 ] && exit 0', 'node x')), [
      [
        'opt-out-after-select-node',
        5,
        'opt-out comes after runtime selection; check it first so an opted-out hook does no work and cannot fail',
      ],
    ]);
  });

  it('reports an opt-out on the line its condition starts', () => {
    const text = hook(SELECT, 'if [[', '$SKIP_HOOK ]]; then exit 0; fi');
    assert.deepEqual(judged(text).map(([rule, line]) => [rule, line]), [
      ['opt-out-after-select-node', 6],
    ]);
  });

  each(['QUIT', '1', '2', '3', '15', 'SIGQUIT', 'hup'])(
    'treats %s as a stop signal',
    signal => {
      assert.deepEqual(rulesHit(hook(`trap 'echo bye' ${signal}`)), [
        'signal-trap-continues',
      ]);
    },
  );

  it('skips trap listings and default restores', () => {
    assert.deepEqual(rulesHit(hook('trap -p INT')), []);
    assert.deepEqual(rulesHit(hook('trap -l')), []);
    assert.deepEqual(rulesHit(hook('trap - INT')), []);
    assert.deepEqual(rulesHit(hook('trap -- - INT')), []);
  });

  it('reads a handler function that ends in exit, nested groups and ${...} included', () => {
    const ending = (...body: string[]) =>
      rulesHit(hook('cleanup() {', ...body, '}', 'trap cleanup INT'));
    assert.deepEqual(ending('  {', '    exit 130', '  }'), []);
    assert.deepEqual(ending('  exit 130', '  {', '  }'), []);
    assert.deepEqual(rulesHit(
        hook(
          'cleanup() { rm -f ${TMPDIR_FOR_THIS_HOOK}; exit 130; }',
          'trap cleanup INT',
        ),
      ), []);
    assert.deepEqual(rulesHit(hook('trap cleanup INT')), [
      'signal-trap-continues',
    ]);
  });

  each([
    'source "$HOME/.nvm/nvm.sh"',
    '\\. "$HOME/.nvm/nvm.sh"',
    '. "$HOME/.nvm/nvm.sh"',
  ])('flags %s as driving nvm', line => {
    assert.deepEqual(rulesHit(hook(line)), ['own-runtime-path']);
  });

  it('keeps the earliest selector source on a line', () => {
    assert.deepEqual(rulesHit(
        hook(
          '. scripts/lib/select-node.sh; select_node || exit 1; source scripts/lib/select-node.sh',
          'node x',
        ),
      ), []);
  });

  it('does not count a selector sourced in a ( ... ) subshell', () => {
    assert.deepEqual(rulesHit(
        hook(
          '( . scripts/lib/select-node.sh; select_node || exit 1 )',
          'node x',
        ),
      ), ['runtime-before-select-node']);
  });

  it('does not count a guarded selection inside a multi-line ( ... ) block', () => {
    assert.deepEqual(rulesHit(
        hook(
          '(',
          '  . scripts/lib/select-node.sh',
          '  select_node || exit 1',
          ')',
          'node x',
        ),
      ), ['runtime-before-select-node']);
  });

  it('reads `&(:)&` as two background lists, not an and-list', () => {
    assert.deepEqual(rulesHit(
        hook(
          '. scripts/lib/select-node.sh &(:)&',
          'select_node || exit 1',
          'node x',
        ),
      ), ['runtime-before-select-node']);
  });

  it('only counts functions that run a Node tool as runtimes', () => {
    assert.deepEqual(rulesHit(hook('say() { echo hi; }', 'say', SELECT, 'node x')), []);
    // A runner elsewhere makes no other function one.
    assert.deepEqual(rulesHit(
        hook('lint() { node x; }', 'say() { echo hi; }', 'say', SELECT, 'lint'),
      ), []);
  });

  it('survives definitions that never close or never open', () => {
    assert.deepEqual(rulesHit('#!/usr/bin/env bash\nnode x\nf()'), [
      'runtime-before-select-node',
    ]);
    assert.deepEqual(rulesHit(hook('echo x', '{ node y; }')), [
      'runtime-before-select-node',
    ]);
    assert.deepEqual(rulesHit(hook('f() {', '  node x')), []);
  });

  it('orders positions strictly', () => {
    assert.equal(isBefore({ index: 1, offset: 2 }, { index: 1, offset: 2 }), false);
    assert.equal(isBefore({ index: 1, offset: 2 }, { index: 1, offset: 3 }), true);
    assert.equal(isBefore({ index: 0, offset: 9 }, { index: 1, offset: 0 }), true);
    assert.equal(isBefore({ index: 1, offset: 0 }, { index: 0, offset: 9 }), false);
  });
});
