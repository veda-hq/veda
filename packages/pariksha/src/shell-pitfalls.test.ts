import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ShellSource } from './shell-sources.ts';
import { checkPitfalls as judgeSource, checkShellText as judgeText, PITFALL_RULES, type PitfallsConfig } from './shell-pitfalls.ts';

/**
 * shell-pitfalls. Each rule has a violating case that fails for that rule, a
 * corrected case, and a near miss: the nearest legitimate shape the rule must
 * leave alone. Fixtures are inline strings so no fixture file is itself a
 * shell target the gate would judge. The config is a product's: its id and
 * the validator tree where process substitution is refused.
 */

const PITFALLS: PitfallsConfig = { id: 'SHELL-03', validatorPaths: [/^scripts\/(?:validations|package-validations)\//] };
const checkShellText = (path: string, text: string) => judgeText(path, text, PITFALLS);
const checkPitfalls = (source: ShellSource) => judgeSource(source, PITFALLS);

/** vitest's `it.each`: an array row is spread into the test; `%s` takes the row's values in order, `$key` an object row's field. */
const each =
  <T,>(rows: readonly T[]) =>
  (name: string, fn: (...args: T extends readonly unknown[] ? T : [T]) => void): void => {
    for (const row of rows) {
      const args = (Array.isArray(row) ? row : [row]) as unknown[];
      let n = 0;
      it(
        name.replace(/%s|\$(\w+)/g, (_match, key?: string) => String(key === undefined ? args[n++] : (row as Record<string, unknown>)[key])),
        () => fn(...(args as unknown as T extends readonly unknown[] ? T : [T])),
      );
    }
  };

const SCRIPT = 'scripts/tools/example.sh';
const VALIDATOR = 'scripts/validations/example/check-example.sh';

const rulesHit = (text: string, path = SCRIPT) => [
  ...new Set(checkShellText(path, text).map(finding => finding.rule)),
];

interface Case {
  rule: string;
  bad: string;
  fixed: string;
  nearMiss: string;
  path?: string;
}

const CASES: Case[] = [
  {
    // The catalogue example: BSD grep reads \s as a literal s, so the coverage threshold was never found.
    rule: 'grep-ere-perl-class',
    bad: 'EXTRACTED_LINES=$(grep -E "lines:\\s*[0-9]+" "$VITEST_CONFIG" | head -1 | grep -oE "[0-9]+" || echo "")\n',
    fixed:
      'EXTRACTED_LINES=$(grep -E "lines:[[:space:]]*[0-9]+" "$VITEST_CONFIG" | head -1 | grep -oE "[0-9]+" || echo "")\n',
    nearMiss:
      'grep -P "lines:\\s*[0-9]+" vitest.config.ts\nsed -E "s/\\s+//" file.txt\n',
  },
  {
    rule: 'xargs-gnu-flag',
    bad: 'git ls-files -z | xargs -0 -r rm --\n',
    fixed: 'git ls-files -z | xargs -0 rm --\n',
    nearMiss: 'printf "%s\\0" "$@" | xargs -0 -n 1 -- echo\n',
  },
  {
    rule: 'xargs-no-null',
    bad: 'git diff --name-only | xargs cat --\n',
    fixed: 'git diff --name-only -z | xargs -0 cat --\n',
    nearMiss: 'COUNT=$(wc -l < list.txt | xargs)\necho "$NAMES" | xargs echo\n',
  },
  {
    rule: 'missing-double-dash',
    bad: 'grep -n "TODO" $CHANGED_FILES\n',
    fixed: 'grep -n "TODO" -- $CHANGED_FILES\n',
    nearMiss: 'grep -q "x" "$CONFIG"\n',
  },
  {
    rule: 'process-substitution-in-validator',
    path: VALIDATOR,
    bad: 'while read -r f; do echo "$f"; done < <(git ls-files)\n',
    fixed:
      'LIST=$(git ls-files)\nwhile read -r f; do echo "$f"; done <<< "$LIST"\n',
    nearMiss: 'echo "compare <(a) with <(b)"\n',
  },
  {
    rule: 'fixed-tmp-path',
    bad: 'pnpm test > /tmp/test-output.log\n',
    fixed: 'LOG=$(mktemp)\npnpm test > "$LOG"\n',
    nearMiss: 'rm -f /tmp/proj-*.log\necho "see /tmp/test-output.log"\n',
  },
  {
    rule: 'machine-local-literal',
    bad: 'export PATH="/opt/homebrew/bin:$PATH"\n',
    fixed: 'export PATH="$(brew --prefix)/bin:$PATH"\n',
    nearMiss:
      'if [ -d /opt/homebrew/bin ]; then\n  export PATH="/opt/homebrew/bin:$PATH"\nfi\n',
  },
  {
    rule: 'nvm-dir-no-default',
    bad: 'export NVM_DIR="$HOME/.nvm"\n',
    fixed: 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"\n',
    nearMiss: '. "$NVM_DIR/nvm.sh"\n',
  },
  {
    rule: 'lockf-without-k',
    bad: 'lockf -t 0 "$LOCK" pnpm test\n',
    fixed: 'lockf -k -t 0 "$LOCK" pnpm test\n',
    nearMiss: 'echo "lockf is macOS-only"\n',
  },
  {
    rule: 'octal-arithmetic',
    bad: 'HOUR=$(date +%H)\nNEXT=$((HOUR + 1))\n',
    fixed: 'HOUR=$(date +%H)\nNEXT=$((10#$HOUR + 1))\n',
    nearMiss: 'COUNT=3\nNEXT=$((COUNT + 1))\n',
  },
  {
    rule: 'dirname-dollar0-beside-bash-source',
    bad: 'HERE="$(dirname "${BASH_SOURCE[0]}")"\nsource "$(dirname "$0")/lib.sh"\n',
    fixed: 'HERE="$(dirname "${BASH_SOURCE[0]}")"\nsource "$HERE/lib.sh"\n',
    nearMiss: 'source "$(dirname "$0")/lib.sh"\n',
  },
  {
    rule: 'worktree-list-no-porcelain',
    bad: "git worktree list | awk '{print $1}'\n",
    fixed: 'git worktree list --porcelain | grep "^worktree "\n',
    nearMiss: 'echo "run git worktree list to see them"\n',
  },
  {
    rule: 'grep-json-key',
    bad: 'VERSION=$(grep -o \'"version": *"[^"]*"\' package.json)\n',
    fixed: 'VERSION=$(node -p "require(\'./package.json\').version")\n',
    nearMiss: 'grep -o "v[0-9.]*" CHANGELOG.md\n',
  },
];

describe('SHELL-03 portability pack', () => {
  it('covers every rule with a case', () => {
    assert.deepEqual(CASES.map(c => c.rule).sort(), [...PITFALL_RULES].sort());
  });

  each(CASES)(
    '$rule: the violating case fails for that rule',
    ({ rule, bad, path }) => {
      assert.deepEqual(rulesHit(bad, path), [rule]);
    },
  );

  each(CASES)('$rule: the corrected case passes', ({ fixed, path }) => {
    assert.deepEqual(rulesHit(fixed, path), []);
  });

  each(CASES)('$rule: the near miss passes', ({ nearMiss, path }) => {
    assert.deepEqual(rulesHit(nearMiss, path), []);
  });

  it('near miss: dirname "$0" quoted as documentation runs no dirname', () => {
    const uses = 'HERE="$(dirname "${BASH_SOURCE[0]}")"\n';
    assert.deepEqual(rulesHit(
        `${uses}echo 'Do not use dirname "$0" here'\nNOTE="dirname \\"\\$0\\""\n`,
      ), []);
    assert.deepEqual(rulesHit(`${uses}cd "$(dirname "$0")" || exit 1\n`), [
      'dirname-dollar0-beside-bash-source',
    ]);
  });

  it('reports the physical line a finding starts on', () => {
    const findings = checkPitfalls({
      path: SCRIPT,
      text: '#!/bin/bash\n# grep -E "\\s" in a comment is fine\necho ok\ngrep -E "a\\sb" \\\n  file.txt\n',
    });
    assert.deepEqual(findings.map(({ check, rule, file, line }) => ({ check, rule, file, line })), [
      {
        check: 'SHELL-03',
        rule: 'grep-ere-perl-class',
        file: SCRIPT,
        line: 4,
      },
    ]);
  });

  it('closes a heredoc on its whole delimiter word, quoted or not', () => {
    for (const opener of [
      '<<EOF.txt',
      "<<'EOF.txt'",
      '<<"EOF.txt"',
      '<<\\EOF.txt',
    ]) {
      const text = `cat ${opener}\ngrep -E "\\s" f\nEOF.txt\ngrep -E "\\d" f\n`;
      assert.deepEqual(checkShellText(SCRIPT, text).map(f => f.line), [4], opener);
    }
  });

  it('reads -e patterns as regexes, never file operands or -f files', () => {
    assert.deepEqual(rulesHit('grep -E -e "[[:space:]]" "docs/\\spec.txt"\n'), []);
    assert.deepEqual(rulesHit('grep -E -f "pats\\s.txt" file\n'), []);
    assert.deepEqual(rulesHit('grep -E -e "a\\sb" file\n'), [
      'grep-ere-perl-class',
    ]);
    assert.deepEqual(rulesHit('grep -Ee "a\\sb" file\n'), [
      'grep-ere-perl-class',
    ]);
    assert.deepEqual(rulesHit('grep -E --regexp="a\\db" file\n'), [
      'grep-ere-perl-class',
    ]);
  });

  it('treats lines inside a multi-line quoted string as text', () => {
    const text =
      'echo "usage:\n  grep -E \\"\\s\\" file\n  lockf -t 0 x y\n"\ngrep -E "\\d" f\n';
    assert.deepEqual(checkShellText(SCRIPT, text).map(f => f.line), [5]);
    // The string and the command after it are one logical line from line 1.
    const single = 'MSG=\'one\ngrep -E "\\s" f\n\'; grep -E "\\d" f\n';
    assert.deepEqual(checkShellText(SCRIPT, single).map(f => f.line), [1]);
    const quotedOnly = 'MSG=\'one\ngrep -E "\\s" f\n\'\necho done\n';
    assert.deepEqual(checkShellText(SCRIPT, quotedOnly), []);
  });

  it('closes a string whose substitution holds its own quotes', () => {
    // The inner "it's" belongs to $(...), so line 1 leaves nothing open.
    const text = 'X="$(printf \'%s\' "it\'s")"\ngrep -E "\\d" f\n';
    assert.deepEqual(checkShellText(SCRIPT, text).map(f => f.line), [2]);
  });

  it('checks substitutions inside a multi-line double-quoted string', () => {
    const text = 'MSG="count:\n$(git ls-files | xargs cat --)\n"\n';
    assert.deepEqual(rulesHit(text), ['xargs-no-null']);
  });

  it('finds a command after a quoted assignment prefix holding blanks', () => {
    assert.deepEqual(rulesHit('LABEL="a b" lockf -t 0 x y\n'), [
      'lockf-without-k',
    ]);
    assert.deepEqual(rulesHit("LABEL='a b' OTHER=c lockf -t 0 x y\n"), [
      'lockf-without-k',
    ]);
  });

  it('checks the substitutions an expanding heredoc runs, not its text', () => {
    const expanding =
      'cat <<EOF\nlines: $(grep -E "a\\sb" f)\ngrep -E "\\s" is text\nEOF\n';
    assert.deepEqual(checkShellText(SCRIPT, expanding).map(f => f.line), [2]);
    const literal = 'cat <<\'EOF\'\nlines: $(grep -E "a\\sb" f)\nEOF\n';
    assert.deepEqual(checkShellText(SCRIPT, literal), []);
  });

  it('opens no heredoc for a `<<TAG` inside a quoted message', () => {
    const text = 'echo "feed it with cat <<EOF"\ngrep -E "\\s" file\n';
    assert.deepEqual(checkShellText(SCRIPT, text).map(f => f.line), [2]);
  });

  it('still opens a heredoc inside a quoted command substitution', () => {
    const text = 'X="$(cat <<EOF\ngrep -E "\\s" f\nEOF\n)"\ngrep -E "\\d" f\n';
    assert.deepEqual(checkShellText(SCRIPT, text).map(f => f.line), [5]);
  });

  it('judges commands inside a quoted command substitution', () => {
    assert.deepEqual(rulesHit('N="$(git ls-files | xargs cat --)"\n'), [
      'xargs-no-null',
    ]);
    assert.deepEqual(rulesHit('echo "`lockf -t 0 x y`"\n'), ['lockf-without-k']);
    assert.deepEqual(rulesHit('echo "lockf -t 0 x y"\n'), []);
  });

  it('ignores heredoc bodies, which are data, not commands', () => {
    const text =
      'cat <<EOF\ngrep -E "\\s" file\nlockf -t 0 x y\nEOF\necho done\n';
    assert.deepEqual(rulesHit(text), []);
  });

  it('keeps judging after a heredoc ends', () => {
    const text =
      'cat <<-EOF\n\tgrep -E "\\s" file\n\tEOF\ngrep -E "\\d" file\n';
    assert.deepEqual(checkShellText(SCRIPT, text).map(f => f.line), [4]);
  });

  it('confines process substitution to validators', () => {
    const text = 'diff <(sort a) <(sort b)\n';
    assert.deepEqual(rulesHit(text, SCRIPT), []);
    assert.deepEqual(rulesHit(text, 'scripts/package-validations/validators/x.sh'), ['process-substitution-in-validator']);
  });

  it('accepts a Homebrew literal paired with its Intel prefix on the line', () => {
    assert.deepEqual(rulesHit('for d in /opt/homebrew/bin /usr/local/bin; do :; done\n'), []);
  });

  it('counts the guard window in code lines, so comments inside it are free', () => {
    const commented =
      'if [ -d /opt/homebrew/bin ]; then\n  # one\n\n  # two\n  # three\n  export PATH="/opt/homebrew/bin:$PATH"\nfi\n';
    assert.deepEqual(rulesHit(commented), []);
    const distant =
      'if [ -d /opt/homebrew/bin ]; then\n  a\n  b\n  c\n  export PATH="/opt/homebrew/bin:$PATH"\nfi\n';
    assert.deepEqual(rulesHit(distant), ['machine-local-literal']);
  });

  it('flags a named emulator and a personal device', () => {
    assert.deepEqual(rulesHit('emulator -avd Pixel_9 &\n'), [
      'machine-local-literal',
    ]);
    assert.deepEqual(rulesHit('DEVICE="Sam\'s iPhone"\n'), [
      'machine-local-literal',
    ]);
    assert.deepEqual(rulesHit('emulator -avd "$PROJ_AVD" &\n'), []);
  });

  it('flags xargs --no-run-if-empty and a clustered -r', () => {
    assert.deepEqual(rulesHit('printf "%s\\0" a | xargs -0r echo\n'), [
      'xargs-gnu-flag',
    ]);
    assert.deepEqual(rulesHit('printf "%s\\0" a | xargs --no-run-if-empty -0 echo\n'), ['xargs-gnu-flag']);
  });

  it('finds a command on its own line inside a multi-line substitution', () => {
    const text = 'VALUE="$(\nlockf -t 0 x y\n)"\n';
    assert.deepEqual(rulesHit(text), ['lockf-without-k']);
  });

  it('keeps the quotes of a substitution in an expanding heredoc', () => {
    // The quoted text stays text: its `| lockf` is no pipeline.
    const quoted = 'cat <<EOF\n$(echo "a | lockf -t 0 x y")\nEOF\n';
    assert.deepEqual(rulesHit(quoted), []);
    const bare = 'cat <<EOF\n"$(echo a | lockf -t 0 x y)"\nEOF\n';
    assert.deepEqual(rulesHit(bare), ['lockf-without-k']);
  });

  it('judges a quoted command word like the bare word', () => {
    assert.deepEqual(rulesHit("'lockf' -t 0 x y\n"), ['lockf-without-k']);
    assert.deepEqual(rulesHit('"lockf" -k -t 0 x y\n'), []);
  });

  it('judges a substitution an expanding heredoc spans over lines', () => {
    const text = 'cat <<EOF\ncount: $(\nlockf -t 0 x y\n)\nEOF\n';
    assert.deepEqual(checkShellText(SCRIPT, text).map(f => f.rule), [
      'lockf-without-k',
    ]);
  });

  it('does not let an unrelated mktemp excuse a fixed /tmp path', () => {
    assert.deepEqual(rulesHit('scratch=$(mktemp); pnpm test > /tmp/test-output.log\n'), ['fixed-tmp-path']);
    assert.deepEqual(rulesHit('scratch=$(mktemp /tmp/proj.XXXXXX)\n'), []);
  });

  it('accepts a single-quoted existence guard', () => {
    assert.deepEqual(rulesHit(
        'if [ -d \'/opt/homebrew/bin\' ]; then\n  PATH="/opt/homebrew/bin:$PATH"\nfi\n',
      ), []);
  });

  it('needs grep -- ahead of the path expansion, not after it', () => {
    assert.deepEqual(rulesHit("grep -n 'TODO' $FILES --\n"), [
      'missing-double-dash',
    ]);
    assert.deepEqual(rulesHit("grep -n 'TODO' -- $FILES\n"), []);
  });

  it('reads clustered xargs options with a value in the next word', () => {
    assert.deepEqual(rulesHit('git ls-files -z | xargs -0n 1 -r rm\n'), [
      'xargs-gnu-flag',
      'missing-double-dash',
    ]);
    assert.deepEqual(rulesHit('git ls-files -z | xargs -0n 1 rm --\n'), []);
  });

  it('fails -I -- : the separator is itself replaced', () => {
    assert.deepEqual(rulesHit('git ls-files -z | xargs -0 -I -- rm -- --\n'), [
      'missing-double-dash',
    ]);
  });

  it('needs -- before the -I replacement, not after it', () => {
    assert.deepEqual(rulesHit('git ls-files -z | xargs -0 -I {} rm {} --\n'), [
      'missing-double-dash',
    ]);
    assert.deepEqual(rulesHit('git ls-files -z | xargs -0 -I {} rm -- {}\n'), []);
  });

  it('keeps an escaped space before a comment: no continuation', () => {
    const text = 'echo ok \\ # note\nrm -f /tmp/x.log\n';
    assert.deepEqual(rulesHit(text), ['fixed-tmp-path']);
  });

  it('judges git worktree list behind a quoted -C path', () => {
    assert.deepEqual(rulesHit('git -C "$ROOT dir" worktree list\n'), [
      'worktree-list-no-porcelain',
    ]);
  });

  it("near miss: a message naming someone's iPhone uses no device", () => {
    assert.deepEqual(rulesHit('echo "pass the device, e.g. Sam\'s iPhone, as $1"\n'), []);
  });

  it('skips the value of a long grep option before taking the pattern', () => {
    assert.deepEqual(rulesHit("grep -E --include '*.sh' '\\s' .\n"), [
      'grep-ere-perl-class',
    ]);
    assert.deepEqual(rulesHit("grep -E --include '*.sh' '[[:space:]]' .\n"), []);
  });

  it('starts a heredoc body only after the continued command line ends', () => {
    const text = "cat <<'EOF' \\\n  > /tmp/shared.log\nbody text\nEOF\n";
    assert.deepEqual(rulesHit(text), ['fixed-tmp-path']);
    assert.deepEqual(rulesHit('cat <<\'EOF\' \\\n  > "$out"\nbody > /tmp/x\nEOF\n'), []);
  });

  it('near miss: an escaped separator or quoted assignment text is not code', () => {
    assert.deepEqual(rulesHit(
        [
          'echo example\\; rm -f /tmp/shared.log',
          'HELP="set OUT=/tmp/x, or NVM_DIR=/opt/nvm, or > /tmp/y"',
          '',
        ].join('\n'),
      ), []);
    assert.deepEqual(rulesHit('OUT=/tmp/x\nexport NVM_DIR=/opt/nvm\n'), [
      'fixed-tmp-path',
      'nvm-dir-no-default',
    ]);
  });

  it('ends a message at a newline inside a multi-line substitution', () => {
    const text = 'X="$(echo ok\ntouch /tmp/shared.log)"\n';
    assert.deepEqual(rulesHit(text), ['fixed-tmp-path']);
  });

  it('judges git worktree list only where git runs', () => {
    assert.deepEqual(rulesHit('echo Run git worktree list to see active worktrees\n'), []);
    assert.deepEqual(rulesHit('git worktree list | awk "{print $1}"\n'), [
      'worktree-list-no-porcelain',
    ]);
  });

  it('judges the regex grep receives, after the shell removes quoting', () => {
    // '\\s' is a literal backslash then s; "\\s" is the same; "\s" is \s.
    assert.deepEqual(rulesHit("grep -E '\\\\s' scripts/example.sh\n"), []);
    assert.deepEqual(rulesHit('grep -E "\\\\\\\\s" f\n'), []);
    assert.deepEqual(rulesHit('grep -E "\\\\s" f\n'), ['grep-ere-perl-class']);
    assert.deepEqual(rulesHit('env LC_ALL=C grep -E "\\s" f\n'), [
      'grep-ere-perl-class',
    ]);
  });

  it('finds a command written against an operator', () => {
    assert.deepEqual(rulesHit('lockf -t 0 x y&& echo done\n'), [
      'lockf-without-k',
    ]);
    assert.deepEqual(rulesHit('true&&lockf -t 0 x y\n'), ['lockf-without-k']);
  });

  it('ends a line at an escaped trailing backslash', () => {
    const text = 'echo done \\\\\nlockf -t 0 x y\n';
    assert.deepEqual(checkShellText(SCRIPT, text).map(f => f.line), [2]);
  });

  it('reads a heredoc after closed arithmetic on the same line', () => {
    const text =
      "count=$((1 + 1)); cat <<'EOF'\nlockf -t 0 x y\nEOF\necho ok\n";
    assert.deepEqual(rulesHit(text), []);
  });

  it('ignores arithmetic text in single quotes', () => {
    assert.deepEqual(rulesHit("HOUR=$(date +%H)\nprintf '%s\\n' '$((HOUR + 1))'\n"), []);
    assert.deepEqual(rulesHit('HOUR=$(date +%H)\necho "$((HOUR + 1))"\n'), [
      'octal-arithmetic',
    ]);
  });

  it('masks only the message: code after its `;` is still judged', () => {
    assert.deepEqual(rulesHit('echo "setup node"; export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"\n'), []);
    assert.deepEqual(rulesHit('echo "node setup"; . "$HOME/.nvm/nvm.sh"\n'), [
      'nvm-dir-no-default',
    ]);
    assert.deepEqual(rulesHit('echo x 2> /tmp/err.log\n'), ['fixed-tmp-path']);
    assert.deepEqual(rulesHit('echo "$(lockf -t 0 x y)" &> "$LOG"\n'), [
      'lockf-without-k',
    ]);
  });

  it('near miss: a help message quoting an NVM_DIR assignment makes none', () => {
    assert.deepEqual(rulesHit("echo 'export NVM_DIR=$HOME/.nvm'\n"), []);
    assert.deepEqual(rulesHit('export NVM_DIR=$HOME/.nvm\n'), [
      'nvm-dir-no-default',
    ]);
  });

  it('reads reserved words as command starts only after a separator', () => {
    assert.deepEqual(rulesHit('echo if lockf -t 0 x y\n'), []);
    assert.deepEqual(rulesHit('if lockf -t 0 x y; then :; fi\n'), [
      'lockf-without-k',
    ]);
    assert.deepEqual(rulesHit('while true; do lockf -t 0 x y; done\n'), [
      'lockf-without-k',
    ]);
  });

  it('accepts -k after an option that takes a value', () => {
    assert.deepEqual(rulesHit('lockf -t 0 -k "$LOCK" pnpm test\n'), []);
    assert.deepEqual(rulesHit('lockf -st 0 "$LOCK" pnpm test\n'), [
      'lockf-without-k',
    ]);
  });

  it('tracks quoted and backtick date assignments for octal arithmetic', () => {
    assert.deepEqual(rulesHit('HOUR="$(date +%H)"\nNEXT=$((HOUR + 1))\n'), [
      'octal-arithmetic',
    ]);
    assert.deepEqual(rulesHit('HOUR=`date +%H`\nNEXT=$((HOUR + 1))\n'), [
      'octal-arithmetic',
    ]);
  });

  it('judges a message redirected to a quoted file, not the message', () => {
    assert.deepEqual(rulesHit('printf "%s\\n" x > "/tmp/out.log"\n'), [
      'fixed-tmp-path',
    ]);
    assert.deepEqual(rulesHit('echo "/opt/homebrew/bin" >> "$LOG"\n'), []);
  });

  it('flags single-quoted fixed /tmp paths like double-quoted ones', () => {
    assert.deepEqual(rulesHit("LOG='/tmp/test-output.log'\n"), [
      'fixed-tmp-path',
    ]);
    assert.deepEqual(rulesHit("touch '/tmp/test-output.log'\n"), [
      'fixed-tmp-path',
    ]);
    assert.deepEqual(rulesHit("pnpm test > '/tmp/test-output.log'\n"), [
      'fixed-tmp-path',
    ]);
    assert.deepEqual(rulesHit("echo 'see /tmp/test-output.log'\n"), []);
  });

  it('ends a heredoc only on an exact delimiter line', () => {
    const text = 'cat <<EOF\nEOF \ngrep -E "\\s" f\nEOF\ngrep -E "\\d" f\n';
    assert.deepEqual(checkShellText(SCRIPT, text).map(f => f.line), [5]);
  });

  it('treats read input like date output for octal arithmetic', () => {
    assert.deepEqual(rulesHit('read -r -p "n? " N\necho $((N * 2))\n'), [
      'octal-arithmetic',
    ]);
    assert.deepEqual(rulesHit('read -r -p "n? " N\necho $((10#$N * 2))\n'), []);
  });

  it('asks for -- when xargs hands paths to grep', () => {
    assert.deepEqual(rulesHit('git ls-files -z | xargs -0 grep -n "x"\n'), [
      'missing-double-dash',
    ]);
  });

  it('does not read `$(( 1 << n ))` as a heredoc', () => {
    assert.deepEqual(rulesHit('MASK=$(( 1 << 4 ))\ngrep -E "\\s" f\n'), [
      'grep-ere-perl-class',
    ]);
  });
});

/** The message each rule prints for its violating case. */
const MESSAGES: Record<string, string> = {
  'grep-ere-perl-class':
    'grep -E pattern uses \\s/\\d, which POSIX ERE and BSD grep do not define; use [[:space:]] or [0-9]',
  'xargs-gnu-flag':
    'xargs -d/-r are GNU-only; BSD xargs on macOS rejects them (use -0 input, or a read loop)',
  'xargs-no-null':
    'xargs splits a file list on blanks and quotes; feed it NUL-delimited paths (tr "\\n" "\\0" | xargs -0)',
  'missing-double-dash':
    'grep gets a list of paths with no `--`; a path starting with - becomes an option',
  'process-substitution-in-validator':
    'process substitution in a validator needs /dev/fd and hides the inner command status; use a here-string or temp file',
  'fixed-tmp-path':
    'fixed /tmp path: concurrent runs collide and another user can pre-create it; use mktemp',
  'machine-local-literal':
    'machine-local path /opt/homebrew/bin; derive it (brew --prefix, $HOME) or guard it with an existence test',
  'nvm-dir-no-default':
    'NVM_DIR overwritten; keep an existing value with ${NVM_DIR:-$HOME/.nvm}',
  'lockf-without-k':
    'lockf without -k removes the lock file on exit, so concurrent runs can lock different inodes',
  'octal-arithmetic':
    'arithmetic on HOUR (read input or date) without 10#: 08 and 09 are invalid octal',
  'dirname-dollar0-beside-bash-source':
    'dirname "$0" beside BASH_SOURCE: when the file is sourced $0 is the caller; use ${BASH_SOURCE[0]}',
  'worktree-list-no-porcelain':
    '`git worktree list` output is for people; parse `git worktree list --porcelain`',
  'grep-json-key':
    'grep -o over JSON keys breaks on reformatted or nested JSON; parse it with node or jq',
};

const messagesFor = (text: string, path = SCRIPT) =>
  checkShellText(path, text).map(finding => finding.message);

describe('SHELL-03 edges the mutation gate found unpinned', () => {
  each(CASES)('$rule: prints its exact message', ({ rule, bad, path }) => {
    assert.deepEqual(messagesFor(bad, path), [MESSAGES[rule]]);
  });

  each([
    [
      'emulator -avd Pixel_9 &\n',
      'literal emulator AVD name; take it from an environment variable or `emulator -list-avds`',
    ],
    [
      'DEVICE="Sam\'s iPhone"\n',
      'a personal device name; take the device from an argument or environment variable',
    ],
    [
      '. "$HOME/.nvm/nvm.sh"\n',
      '$HOME/.nvm assumed; honour a custom install with ${NVM_DIR:-$HOME/.nvm}',
    ],
    [
      'git ls-files -z | xargs -0 rm\n',
      'xargs appends paths to rm with no `--`; a path starting with - becomes an option',
    ],
    [
      'git ls-files -z | xargs -0 /bin/rm\n',
      'xargs appends paths to rm with no `--`; a path starting with - becomes an option',
    ],
  ])('%s prints its exact message', (text, message) => {
    assert.deepEqual(messagesFor(text), [message]);
  });

  it('reads a word after grep -- as an operand, even one starting with -', () => {
    assert.deepEqual(rulesHit(String.raw`grep -E -- -x\\\s file` + '\n'), [
      'grep-ere-perl-class',
    ]);
  });

  it('reads --regexp and --regexp= patterns, and --file as a pattern source', () => {
    assert.deepEqual(rulesHit(String.raw`grep -E --regexp "a\s" file` + '\n'), [
      'grep-ere-perl-class',
    ]);
    assert.deepEqual(rulesHit(String.raw`grep -E --regexp="a\s" file` + '\n'), [
      'grep-ere-perl-class',
    ]);
    assert.deepEqual(rulesHit('grep -E --regexp\n'), []);
    assert.deepEqual(rulesHit('grep -E -e\n'), []);
    // `=` holds the value: the next word is a file.
    assert.deepEqual(rulesHit('grep --regexp=x $FILES\n'), [
      'missing-double-dash',
    ]);
    assert.deepEqual(rulesHit('grep --file=pats.txt $FILES\n'), [
      'missing-double-dash',
    ]);
    assert.deepEqual(rulesHit(String.raw`grep -E --file pats.txt "a\s"` + '\n'), []);
  });

  each(['--regexp', '-e'])(
    'takes only the word after %s as its pattern, not an earlier value',
    flag => {
      assert.deepEqual(rulesHit(String.raw`grep -E --include "*\d*" ${flag} x file` + '\n'), []);
    },
  );

  it('reads every operand after -f as a file', () => {
    assert.deepEqual(rulesHit('grep -f pats.txt $FILES\n'), [
      'missing-double-dash',
    ]);
  });

  it('skips the value of -m, alone or attached, before the pattern', () => {
    assert.deepEqual(rulesHit(String.raw`grep -E -m 1 "a\s" file` + '\n'), [
      'grep-ere-perl-class',
    ]);
    assert.deepEqual(rulesHit(String.raw`grep -E -m1 "a\s" file` + '\n'), [
      'grep-ere-perl-class',
    ]);
    assert.deepEqual(rulesHit(String.raw`grep -E -e"a\s" file` + '\n'), [
      'grep-ere-perl-class',
    ]);
  });

  it('judges egrep and --extended-regexp as ERE, plain grep and -F/-P not', () => {
    assert.deepEqual(rulesHit(String.raw`egrep "a\s" file` + '\n'), [
      'grep-ere-perl-class',
    ]);
    assert.deepEqual(rulesHit(String.raw`grep --extended-regexp "a\s" file` + '\n'), ['grep-ere-perl-class']);
    assert.deepEqual(rulesHit(String.raw`grep "a\s" file` + '\n'), []);
    assert.deepEqual(rulesHit(String.raw`grep -E -F "a\s" file` + '\n'), []);
    assert.deepEqual(rulesHit(String.raw`grep -E -P "a\s" file` + '\n'), []);
  });

  it('joins adjacent quoted parts of a pattern as the shell does', () => {
    // '\' then "s" is the two characters \s.
    assert.deepEqual(rulesHit(String.raw`grep -E '\'"s" file` + '\n'), [
      'grep-ere-perl-class',
    ]);
    // '\' then \x is \x: no class, and nothing joins between the parts.
    assert.deepEqual(rulesHit(String.raw`grep -E '\'\x file` + '\n'), []);
    // "x\\\s" is x, one backslash from \\, then \s: an even run, a literal.
    assert.deepEqual(rulesHit(String.raw`grep -E "x\\\s" file` + '\n'), []);
  });

  each([
    'grep',
    'egrep',
    'fgrep',
    'rm',
    'cat',
    'wc',
    'head',
    'tail',
    'sed',
    'ls',
    'mv',
    'cp',
    'chmod',
  ])('asks for -- when xargs hands paths to %s', command => {
    assert.deepEqual(messagesFor(`git ls-files -z | xargs -0 ${command}\n`), [
      `xargs appends paths to ${command} with no \`--\`; a path starting with - becomes an option`,
    ]);
  });

  it('reads a word after xargs -- as the command, never an option', () => {
    assert.deepEqual(rulesHit('git ls-files -z | xargs -0 -- -r\n'), []);
  });

  it('takes a replacement string from -I or -J only', () => {
    assert.deepEqual(rulesHit('git ls-files -z | xargs -0 -n 2 sed -e s/x/2/ --\n'), []);
    assert.deepEqual(rulesHit('git ls-files -z | xargs -0 -J % rm % --\n'), [
      'missing-double-dash',
    ]);
  });

  it('flags xargs -d', () => {
    assert.deepEqual(rulesHit("printf 'a\\n' | xargs -d '\\n' echo\n"), [
      'xargs-gnu-flag',
    ]);
  });

  it('asks for NUL input only when xargs runs a command on a file list', () => {
    assert.deepEqual(rulesHit('FILES=$(git diff --name-only | xargs)\n'), []);
    assert.deepEqual(rulesHit('git diff --name-only | xargs -n 1 cat --\n'), [
      'xargs-no-null',
    ]);
    assert.deepEqual(rulesHit('git diff --name-only -z | xargs --null cat --\n'), []);
  });

  it('reads a quoted array expansion as a list of paths', () => {
    assert.deepEqual(rulesHit('grep x "${FILES[@]}"\n'), ['missing-double-dash']);
  });

  each(['tee', 'cat', 'mkdir', 'cp', 'mv', 'ln', 'chmod', 'touch', 'rm'])(
    'flags a fixed /tmp operand of %s',
    command => {
      assert.deepEqual(rulesHit(`${command} x /tmp/proj-x\n`), [
        'fixed-tmp-path',
      ]);
    },
  );

  it('excuses only a Homebrew literal by the Intel prefix on its line', () => {
    assert.deepEqual(rulesHit('cp /Users/sam/x /usr/local/bin\n'), [
      'machine-local-literal',
    ]);
  });

  it('guards a literal under a tested directory, not a sibling of it', () => {
    assert.deepEqual(rulesHit(
        '[ -d /opt/homebrew/ ] && export PATH="/opt/homebrew/bin:$PATH"\n',
      ), []);
    assert.deepEqual(rulesHit('[ -d /opt/home ] && export PATH="/opt/homebrew/bin:$PATH"\n'), ['machine-local-literal']);
    assert.deepEqual(rulesHit(
        '[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/sbin:$PATH"\n',
      ), ['machine-local-literal']);
  });

  it("reads lockf's options up to the locked command, which keeps its own", () => {
    assert.deepEqual(rulesHit('lockf -k\n'), []);
    assert.deepEqual(rulesHit('lockf "$LOCK" sort -k 2 file\n'), [
      'lockf-without-k',
    ]);
  });

  it("skips a read option's value: it names no variable", () => {
    assert.deepEqual(rulesHit('read -t 5 HOUR\necho $((HOUR + 1))\n'), [
      'octal-arithmetic',
    ]);
    assert.deepEqual(rulesHit('read -p Hour HOUR\necho $((Hour + 1))\n'), []);
  });

  it('keeps arithmetic after a closed, escaped or double-quoted single quote', () => {
    const date = 'HOUR=$(date +%H)\n';
    assert.deepEqual(rulesHit(`${date}echo 'x'; N=$((HOUR + 1))\n`), [
      'octal-arithmetic',
    ]);
    assert.deepEqual(rulesHit(`${date}echo \\'; N=$((HOUR + 1))\n`), [
      'octal-arithmetic',
    ]);
    assert.deepEqual(rulesHit(`${date}echo "'"; N=$((HOUR + 1))\n`), [
      'octal-arithmetic',
    ]);
    assert.deepEqual(rulesHit(`${date}echo "x" '$((HOUR + 1))'\n`), []);
  });

  it('reads ANSI-C and locale quotes in a grep pattern as bash does', () => {
    const hit = (word: string): string[] => rulesHit(`grep -E ${word} f\n`);
    // $'\\s' passes \s: inside $'…' a doubled backslash is one.
    assert.deepEqual(hit(String.raw`$'\\s'`), ['grep-ere-perl-class']);
    // $'\\\s' passes \\s, an escaped backslash then s.
    assert.deepEqual(hit(String.raw`$'\\\s'`), []);
    assert.deepEqual(hit(String.raw`$'\'\\s'`), ['grep-ere-perl-class']);
    // The $ of $"…" is no character of the value: \\ then $"\s" is \\s.
    assert.deepEqual(hit(String.raw`\\$"\s"`), []);
    assert.deepEqual(hit(String.raw`$"\\s"`), ['grep-ere-perl-class']);
  });

  it('evaluates only the arithmetic bash evaluates inside quotes', () => {
    const date = 'HOUR=$(date +%H)\n';
    const hit = (word: string): string[] =>
      rulesHit(`${date}printf '%s\\n' ${word}\n`);
    // An escaped $ or a bare (( inside double quotes prints its text.
    assert.deepEqual(hit(String.raw`"\$((HOUR + 1))"`), []);
    assert.deepEqual(hit('"((HOUR + 1))"'), []);
    assert.deepEqual(hit(String.raw`"\\$((HOUR + 1))"`), ['octal-arithmetic']);
    assert.deepEqual(hit('"$(((HOUR) + 1))"'), ['octal-arithmetic']);
    // $'…' text is printed; \' inside it closes nothing.
    assert.deepEqual(hit(String.raw`$'a\' $((HOUR + 1))'`), []);
    assert.deepEqual(hit(String.raw`$'\''$((HOUR + 1))`), ['octal-arithmetic']);
    assert.deepEqual(hit(`$"$((HOUR + 1))"`), ['octal-arithmetic']);
    // An escaped quote opens no string: the (( command after it runs.
    assert.deepEqual(rulesHit(`${date}echo \\"; (( N = HOUR + 1 ))\n`), [
      'octal-arithmetic',
    ]);
  });
});
