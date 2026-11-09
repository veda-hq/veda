import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type * as TS from 'typescript';
import { DEFAULT_WORDS, formatReads, listFiles, parseConfig, readerFor, readGate, UnreadableGateFile, type Reads } from './env-gate-switches.ts';
import { loadTypescript, type Ts } from './typescript.ts';

const loaded = loadTypescript();
if (typeof loaded === 'string') throw new Error(loaded);
const ts: Ts = loaded;

/** A product's config: its hooks, scripts and workflows, less tests, fixtures and docs, and one approved setup switch. */
const PRODUCT_CONFIG = {
  gatePaths: ['^\\.husky/', '^scripts/', '^\\.claude/hooks/', '^\\.claude/scripts/', '^\\.github/workflows/'],
  notGateCode: ['\\.test\\.[cm]?[jt]sx?$', '\\.properties\\.test\\.ts$', '(?:^|/)test_[^/]*\\.py$', '\\.test\\.sh$', '(?:^|/)fixtures?/', '\\.fixture\\.[cm]?[jt]s$', '\\.md$'],
  notAGate: {
    SETUP_SKIP_MOBILE: {
      files: ['scripts/setup-machine.sh', 'scripts/lib/setup-machine-steps.sh'],
      reason: 'setup-machine.sh --skip-mobile: installs no mobile toolchain on a machine that builds none; checks nothing',
    },
  },
};

const CONFIG = parseConfig(JSON.stringify(PRODUCT_CONFIG));
const reader = readerFor(CONFIG);
const findSwitchReads = (file: string, source: string, compiler: Ts = ts) => reader.findSwitchReads(file, source, compiler);
const names = (file: string, source: string, compiler: Ts = ts): string[] => findSwitchReads(file, source, compiler).map((v) => v.name);
const j = (s: string): string => JSON.stringify(s);

/** The real compiler, watched: each program it builds is counted, and each file or directory its host reads is recorded. */
const watchedCompiler = () => {
  const seen = { built: 0, asked: new Set<string>() };
  const watch =
    <Rest extends unknown[], Result>(read: (name: string, ...rest: Rest) => Result) =>
    (name: string, ...rest: Rest): Result => {
      seen.asked.add(name);
      return read(name, ...rest);
    };
  const createProgram = ((input: TS.CreateProgramOptions): TS.Program => {
    seen.built += 1;
    const host = input.host ?? ts.createCompilerHost(input.options);
    const { directoryExists, getDirectories } = host;
    return ts.createProgram({
      ...input,
      host: {
        ...host,
        getSourceFile: watch(host.getSourceFile),
        fileExists: watch(host.fileExists),
        readFile: watch(host.readFile),
        ...(directoryExists === undefined ? {} : { directoryExists: watch(directoryExists) }),
        ...(getDirectories === undefined ? {} : { getDirectories: watch(getDirectories) }),
      },
    });
  }) as Ts['createProgram'];
  return { seen, compiler: { ...ts, createProgram } as Ts };
};

describe('parseConfig', () => {
  it('reads the lists, defaults the words, and leaves the optional keys empty', () => {
    assert.deepEqual(CONFIG.words, DEFAULT_WORDS);
    assert.equal(CONFIG.gatePaths.length, 5);
    assert.equal(CONFIG.notGateCode.length, 7);
    assert.deepEqual(CONFIG.notAGate, PRODUCT_CONFIG.notAGate);
    const bare = parseConfig('{"gatePaths": ["^hooks/"], "words": ["BYPASS", "NO2"]}');
    assert.deepEqual(bare, { gatePaths: [/^hooks\//], notGateCode: [], notAGate: {}, words: ['BYPASS', 'NO2'] });
  });

  it('refuses what would check nothing or the wrong thing', () => {
    const bad: Array<[string, RegExp]> = [
      ['nope', /not JSON/],
      ['[]', /must be a JSON object/],
      ['{"gatePaths": ["^a/"], "extra": 1}', /unknown key "extra"/],
      ['{}', /"gatePaths" is empty, so nothing would be checked/],
      ['{"gatePaths": []}', /"gatePaths" is empty/],
      ['{"gatePaths": "^a/"}', /"gatePaths" must be a list of non-empty regular expressions/],
      ['{"gatePaths": [""]}', /"gatePaths" must be a list/],
      ['{"gatePaths": ["("]}', /gatePaths: "\(" is not a regular expression: /],
      ['{"gatePaths": ["^a/"], "notGateCode": [1]}', /"notGateCode" must be a list/],
      ['{"gatePaths": ["^a/"], "notGateCode": ["[z-a]"]}', /notGateCode: "\[z-a\]" is not a regular expression/],
      ['{"gatePaths": ["^a/"], "words": []}', /"words" must be a non-empty list/],
      ['{"gatePaths": ["^a/"], "words": "SKIP"}', /"words" must be a non-empty list/],
      ['{"gatePaths": ["^a/"], "words": ["skip"]}', /words: "skip" is not an upper-case word/],
      ['{"gatePaths": ["^a/"], "words": ["SKIP", "A_B"]}', /words: "A_B" is not an upper-case word/],
      ['{"gatePaths": ["^a/"], "words": [""]}', /words: "" is not/],
      ['{"gatePaths": ["^a/"], "words": [3]}', /words: 3 is not/],
      ['{"gatePaths": ["^a/"], "notAGate": []}', /"notAGate" must be an object/],
      // `null` is a value of the wrong type, not a missing key.
      ['{"gatePaths": null}', /"gatePaths" must be a list/],
      ['{"gatePaths": ["^a/"], "notGateCode": null}', /"notGateCode" must be a list/],
      ['{"gatePaths": ["^a/"], "words": null}', /"words" must be a non-empty list/],
      ['{"gatePaths": ["^a/"], "notAGate": null}', /"notAGate" must be an object/],
      ['{"gatePaths": ["^a/"], "notAGate": {"HOME": {"files": ["a"], "reason": "r"}}}', /notAGate: "HOME" is not a switch name, so it allows nothing/],
      ['{"gatePaths": ["^a/"], "notAGate": {"X_SKIP": true}}', /notAGate\.X_SKIP must be an object/],
      ['{"gatePaths": ["^a/"], "notAGate": {"X_SKIP": {"files": ["a"], "reason": "r", "more": 1}}}', /notAGate\.X_SKIP: unknown key "more"/],
      ['{"gatePaths": ["^a/"], "notAGate": {"X_SKIP": {"reason": "r"}}}', /notAGate\.X_SKIP\.files must be a non-empty list of paths/],
      ['{"gatePaths": ["^a/"], "notAGate": {"X_SKIP": {"files": [], "reason": "r"}}}', /notAGate\.X_SKIP\.files must be a non-empty list/],
      ['{"gatePaths": ["^a/"], "notAGate": {"X_SKIP": {"files": ["./a"], "reason": "r"}}}', /notAGate\.X_SKIP\.files: "\.\/a" is not a normalized root-relative path/],
      ['{"gatePaths": ["^a/"], "notAGate": {"X_SKIP": {"files": ["a"]}}}', /notAGate\.X_SKIP needs a reason/],
      ['{"gatePaths": ["^a/"], "notAGate": {"X_SKIP": {"files": ["a"], "reason": "  "}}}', /notAGate\.X_SKIP needs a reason/],
      ['{"gatePaths": ["^a/"], "words": ["BYPASS"], "notAGate": {"X_SKIP": {"files": ["a"], "reason": "r"}}}', /"X_SKIP" is not a switch name/],
    ];
    for (const [text, message] of bad) assert.throws(() => parseConfig(text), message, text);
  });
});

describe('readerFor, with other words', () => {
  it('reads the switches its words name, and only those', () => {
    const own = readerFor(parseConfig('{"gatePaths": ["^hooks/"], "words": ["BYPASS"]}'));
    const found = (source: string) => own.findSwitchReads('hooks/gate.sh', source, undefined).map((v) => v.name);
    assert.deepEqual(found('[ -n "$PUSH_BYPASS" ] && exit 0\n[ -n "$PUSH_SKIP" ] && exit 0'), ['PUSH_BYPASS']);
    assert.equal(own.isGateCode('hooks/gate.sh'), true);
    assert.equal(own.isGateCode('scripts/gate.sh'), false);
  });

  it('needs the compiler only for a TypeScript or JavaScript file', () => {
    assert.deepEqual(reader.findSwitchReads('scripts/gate.sh', 'echo "$A_SKIP"', undefined).length, 1);
    assert.throws(() => reader.findSwitchReads('scripts/gate.ts', 'process.env.A_SKIP', undefined), /scripts\/gate\.ts: reading TypeScript or JavaScript needs the typescript package/);
  });
});

describe('formatReads', () => {
  it('names the words in a pass and the config in a refusal', () => {
    assert.deepEqual(formatReads([], ['SKIP', 'PROBE'], 3, 'gates.json'), {
      ok: true,
      out: ['pariksha env-gate-switches: no gate reads a *_SKIP / *_PROBE environment switch (3 gate file(s) read)'],
      err: [],
    });
    assert.deepEqual(formatReads([{ file: 'a.sh', line: 2, name: 'A_BYPASS' }], ['BYPASS'], 1, 'gates.json'), {
      ok: false,
      out: [],
      err: [
        'pariksha env-gate-switches: gate code reads an environment switch anyone can set to turn it off:',
        '   a.sh:2 reads A_BYPASS',
        'pariksha env-gate-switches: 1 read(s). Decide inside the gate (a flag the gate owns, a file it checks), or, if the switch turns off no check at all, add it to notAGate in gates.json with the reason.',
      ],
    });
  });
});

describe('readGate', () => {
  const reads = (over: Partial<Reads>): Reads => ({ git: { run: () => 'text' }, read: () => 'disk', ...over });
  /** A read that fails as the system would, with `code`. */
  const failing = (code: string | undefined) =>
    reads({
      read: () => {
        throw Object.assign(new Error(`${String(code)}: cannot read`), { code });
      },
    });

  it('reads the index for staged and the working tree for tree, skipping a file that is gone', () => {
    const asked: string[][] = [];
    assert.equal(readGate(reads({ git: { run: (args) => (asked.push([...args]), 'index') } }), 'staged', { file: '0:a.sh', symlink: false }), 'index');
    assert.deepEqual(asked, [['show', ':0:0:a.sh']]);
    assert.equal(readGate(reads({}), 'tree', { file: 'a.sh', symlink: false }), 'disk');
    assert.equal(readGate(failing('ENOENT'), 'tree', { file: 'a.sh', symlink: false }), undefined);
    assert.equal(readGate(failing('ENOTDIR'), 'tree', { file: 'a.sh', symlink: false }), undefined);
  });

  it('throws, naming the file, when it cannot read one that is there', () => {
    assert.throws(() => readGate(reads({ git: { run: () => undefined } }), 'staged', { file: 'a.sh', symlink: false }), /^Error: a\.sh: git show :0:a\.sh failed$/);
    for (const code of ['EISDIR', 'EACCES', 'EIO', undefined]) {
      assert.throws(() => readGate(failing(code), 'tree', { file: 'a.sh', symlink: false }), (e: unknown) => e instanceof UnreadableGateFile && e.message === `a.sh: ${String(code)}: cannot read`, String(code));
    }
  });
});

describe('findSwitchReads', () => {
  const reading: Array<[string, string, string]> = [
    ['.husky/pre-push', 'if [ -n "$PREPUSH_SKIP" ]; then exit 0; fi', 'PREPUSH_SKIP'],
    // The setup exemption holds only in setup-machine; in a hook it is a
    // gate switch like any other.
    ['.husky/pre-push', 'if [ "$SETUP_SKIP_MOBILE" = 1 ]; then exit 0; fi', 'SETUP_SKIP_MOBILE'],
    ['.husky/pre-push', '[ "${TOOLING_PROBE:-}" = 1 ] && exit 0', 'TOOLING_PROBE'],
    ['scripts/gate.sh', 'test -z "$SKIP_MUTATION" || exit 0', 'SKIP_MUTATION'],
    ['scripts/gate.sh', 'X_SKIP="${X_SKIP:-0}"\n[ "$X_SKIP" = 1 ] && exit 0', 'X_SKIP'],
    ['scripts/gate.ts', "if (process.env.GATE_SKIP === '1') process.exit(0);", 'GATE_SKIP'],
    ['scripts/gate.ts', "if (process.env['GATE_SKIP']) return;", 'GATE_SKIP'],
    ['scripts/gate.ts', 'const { env } = process; if (env?.CHECK_PROBE) return;', 'CHECK_PROBE'],
    ['.claude/hooks/guard.py', "if os.environ.get('GUARD_SKIP'): sys.exit(0)", 'GUARD_SKIP'],
    ['scripts/lib/guard.py', "if os.environ['GUARD_SKIP']: sys.exit(0)", 'GUARD_SKIP'],
    ['.claude/hooks/lib/guard.py', "if os.getenv('GUARD_PROBE'): sys.exit(0)", 'GUARD_PROBE'],
    ['.github/workflows/ci.yml', "if: ${{ env.CI_SKIP != '1' }}", 'CI_SKIP'],
    ['.github/workflows/ci.yml', 'run: test -n "$LINT_SKIP" || pnpm lint', 'LINT_SKIP'],
  ];
  for (const [file, source, name] of reading) {
    it(`${file} reads ${name}`, () => {
      assert.ok(names(file, source).includes(name));
    });
  }

  const passing: Array<[string, string]> = [
    // A hook that initialises its own decision first.
    ['.husky/pre-push', 'TOOLING_DOCKER_SKIP=""\nif [ -n "$TOOLING_DOCKER_SKIP" ]; then :; fi'],
    ['.husky/pre-push', 'BOUNDED_PROBE=0\nif [ "$BOUNDED_PROBE" = 1 ]; then :; fi'],
    // Setup, not a gate, allowed with its reason.
    ['scripts/setup-machine.sh', 'if [ "$SETUP_SKIP_MOBILE" = 1 ]; then return; fi'],
    // Names that only contain the letters.
    ['scripts/gate.sh', 'echo "$SKIPPED_COUNT $PROBES"'],
    ['scripts/gate.ts', 'const skip = process.env.SKIPPER;'],
    // A comment is not a read.
    ['scripts/gate.sh', '# never read $GATE_SKIP here'],
    ['.claude/hooks/guard.py', "# os.environ.get('GUARD_SKIP') was removed"],
    // Not a kind of file the check reads.
    ['scripts/notes.txt', 'echo "$GATE_SKIP"'],
  ];
  for (const [file, source] of passing) {
    it(`${file} passes: ${j(source)}`, () => {
      assert.deepEqual(names(file, source), []);
    });
  }

  it('counts an initialisation only when it comes before the read', () => {
    assert.deepEqual(names('.husky/pre-push', '[ -n "$LATE_SKIP" ] && exit 0\nLATE_SKIP=1'), ['LATE_SKIP']);
  });

  it('counts only top-level initialisations', () => {
    assert.deepEqual(names('.husky/pre-push', 'if x; then\n  BRANCH_SKIP=1\nfi\n[ -n "$BRANCH_SKIP" ] && exit 0'), ['BRANCH_SKIP']);
  });

  const notCounted: Array<[string, string]> = [
    ['an indented branch', '  if false; then\nPUSH_SKIP=1\n  fi'],
    ['an unindented branch', 'if false; then\nPUSH_SKIP=1\nfi'],
    ['a case arm', 'case "$1" in\nx)\nPUSH_SKIP=1\n;;\nesac'],
    ['a loop', 'while false; do\nPUSH_SKIP=1\ndone'],
    ['a function', 'setup() {\nPUSH_SKIP=1\n}'],
    ["a command's environment", 'PUSH_SKIP=1 true'],
    ['a subshell', '(\nPUSH_SKIP=0\n)'],
    ['an indented subshell', '  (\nPUSH_SKIP=0\n  )'],
    ['a subshell after then', 'if true; then (\nPUSH_SKIP=0\n); fi'],
    ['the background', 'PUSH_SKIP=0&'],
    ['a pipeline', 'PUSH_SKIP=0 | cat'],
  ];
  for (const [label, before] of notCounted) {
    it(`does not count an assignment in ${label}`, () => {
      assert.deepEqual(names('.husky/pre-push', `${before}\n[ -n "$PUSH_SKIP" ] && exit 0`), ['PUSH_SKIP']);
    });
  }

  for (const init of [
    'PUSH_SKIP=0;',
    'PUSH_SKIP=$(date +%s)',
    'PUSH_SKIP="" # off',
    // A `\` joins only the next line, which is blank here.
    'echo a \\\n\nPUSH_SKIP=0',
  ]) {
    it(`counts the top-level initialisation ${j(init)}`, () => {
      assert.deepEqual(names('.husky/pre-push', `${init}\n[ -n "$PUSH_SKIP" ] && exit 0`), []);
    });
  }

  const conditional: Array<[string, string]> = [
    ['a continued line', 'false && \\\nPUSH_SKIP=0'],
    ['a trailing &&', 'false &&\nPUSH_SKIP=0'],
    ['a trailing && then a blank line', 'false &&\n\nPUSH_SKIP=0'],
    ['a trailing || then a comment', 'true ||\n# reset\nPUSH_SKIP=0'],
    ['a trailing ||', 'true ||\nPUSH_SKIP=0'],
  ];
  for (const [label, before] of conditional) {
    it(`does not count the end of a conditional list: ${label}`, () => {
      assert.deepEqual(names('.husky/pre-push', `${before}\n[ -n "$PUSH_SKIP" ] && exit 0`), ['PUSH_SKIP']);
    });
  }

  for (const source of ["printf '%s\\n' 'Do not use $PUSH_SKIP'", 'echo ok # was: [ -n "$PUSH_SKIP" ] && exit 0', 'cat <<\'EOF\'\n[ -n "$PUSH_SKIP" ] && exit 0\nEOF', 'cat <<\\EOF\n$PUSH_SKIP\nEOF']) {
    it(`text bash does not expand is not a read: ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), []);
    });
  }

  for (const source of [
    'echo "skip is $PUSH_SKIP"',
    'cat <<EOF\n$PUSH_SKIP\nEOF',
    'echo "it\'s $PUSH_SKIP"',
    // `<<` in quotes, a comment or arithmetic opens no heredoc.
    'echo "<<\'EOF\'"\n[ -n "$PUSH_SKIP" ] && exit 0',
    'echo \'<<\\EOF\'\n[ -n "$PUSH_SKIP" ] && exit 0',
    'echo ok # cat <<\'EOF\'\n[ -n "$PUSH_SKIP" ] && exit 0',
    'echo $((1<<2))\n[ -n "$PUSH_SKIP" ] && exit 0',
    // A heredoc ends only at its exact delimiter; `<<-` strips tabs.
    'cat <<\'EOF\'\n  EOF\nEOF\n[ -n "$PUSH_SKIP" ] && exit 0',
    'cat <<-\'EOF\'\n\tbody\n\tEOF\n[ -n "$PUSH_SKIP" ] && exit 0',
    'cat <<$\'EOF\'\nbody\nEOF\n[ -n "${PUSH_SKIP:-}" ] && exit 0',
    // Two heredocs on one line: the second body follows the first.
    "cat <<'A' <<B\nfirst\nA\n$PUSH_SKIP\nB",
    // An unquoted body expands, and `#` in it is no comment.
    'cat <<EOF\n# $PUSH_SKIP\nEOF',
  ]) {
    it(`an expanding string or heredoc is a read: ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), ['PUSH_SKIP']);
    });
  }

  for (const source of ['print("use os.environ.get(\'PUSH_SKIP\') no more")', "x = 1  # os.environ['PUSH_SKIP']", '"""Removed:\nos.environ.get("PUSH_SKIP")\n"""', "msg = r'os.getenv(\\'PUSH_PROBE\\')'", "s = 'unterminated os.environ['PUSH_SKIP']"]) {
    it(`Python strings and comments read nothing: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.py', source), []);
    });
  }

  for (const source of [
    "if os.environ.get('PUSH_SKIP'):\n    sys.exit(0)",
    'x = f"{os.environ[\'PUSH_SKIP\']}"',
    "'''doc'''\nskip = os.getenv(\"PUSH_SKIP\")",
    "a = 'it''s'\nb = os.environ['PUSH_SKIP']",
    'if os.environ.get(\n    "PUSH_SKIP"\n):\n    sys.exit(0)',
    "os.environ['PUSH_SKIP'] += '1'",
  ]) {
    it(`Python reads in code are found: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.py', source), ['PUSH_SKIP']);
    });
  }

  for (const source of ['os.environ["PUSH_SKIP"] = "0"', 'del os.environ["PUSH_SKIP"]', "del environ['PUSH_SKIP']"]) {
    it(`Python writes are not reads: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.py', source), []);
    });
  }

  it('reports a multiline Python read at the line it starts', () => {
    assert.deepEqual(findSwitchReads('scripts/gate.py', 'x = 1\nos.getenv(\n  "PUSH_SKIP")'), [{ file: 'scripts/gate.py', line: 2, name: 'PUSH_SKIP' }]);
  });

  for (const source of ['      # Removed bypass: ${{ env.CI_SKIP }}', '      run: echo ok # was: $PUSH_SKIP']) {
    it(`a workflow comment reads nothing: ${j(source)}`, () => {
      assert.deepEqual(names('.github/workflows/ci.yml', source), []);
    });
  }

  const workflowReads: Array<[string, string]> = [
    ['      if: ${{ env.CI_SKIP }}', 'CI_SKIP'],
    ['      run: echo "a # b" && test -n "$PUSH_SKIP"', 'PUSH_SKIP'],
    ["      run: echo 'it''s' $PUSH_SKIP", 'PUSH_SKIP'],
    ['      run: echo "a \\" # b" $PUSH_SKIP', 'PUSH_SKIP'],
    ["      if: ${{ env['CI_SKIP'] != '1' }}", 'CI_SKIP'],
    ['      if: ${{ env[ "CI_SKIP" ] }}', 'CI_SKIP'],
    ['      run: if (( PUSH_SKIP )); then exit 0; fi', 'PUSH_SKIP'],
  ];
  for (const [source, name] of workflowReads) {
    it(`a workflow read outside comments counts: ${j(source)}`, () => {
      assert.deepEqual(names('.github/workflows/ci.yml', source), [name]);
    });
  }

  for (const source of [
    'if (( PUSH_SKIP )); then exit 0; fi',
    '(( PUSH_SKIP > 0 )) && exit 0',
    '[ $(( PUSH_SKIP + 0 )) -gt 0 ] && exit 0',
    'let "x = PUSH_SKIP"; [ "$x" = 1 ] && exit 0',
    '[[ PUSH_SKIP -eq 1 ]] && exit 0',
    '[[ 1 -eq PUSH_SKIP ]] && exit 0',
    'echo "${modes[PUSH_SKIP]}"',
  ]) {
    it(`bash reads a bare name in arithmetic: ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), ['PUSH_SKIP']);
    });
  }

  for (const source of [
    "printf '%s\\n' $'don\\'t use $PUSH_SKIP'",
    // Across lines too: `\'` on the next line still closes nothing.
    "printf '%s\\n' $'line one\nit\\'s $PUSH_SKIP'",
  ]) {
    it(`an ANSI-C quote holds its escaped quote: ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), []);
    });
  }

  for (const source of [
    // An escaped backslash ends no quote, so the `'` after it closes it.
    "echo $'a\\\\' $PUSH_SKIP",
    // Continued on the next line, `\\\'` is an escaped backslash and an
    // escaped quote: the string closes at the `'` after ` x`.
    "echo $'one\n\\\\\\' x' $PUSH_SKIP",
  ]) {
    it(`a read after an ANSI-C quote closes is a read: ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), ['PUSH_SKIP']);
    });
  }

  it("an escaped dollar opens a plain quote: \\$'…'", () => {
    assert.deepEqual(names('.husky/pre-push', "echo \\$'x\\' $PUSH_SKIP"), ['PUSH_SKIP']);
  });

  for (const source of [
    "let settings;\nsettings = process.env;\nif (settings.PUSH_SKIP === '1') process.exit(0);",
    'let s;\nlet t;\ns = process.env;\nt ??= s;\nif (t.PUSH_SKIP) process.exit(0);',
    // `&&=` assigns when the left is truthy, and `{}` is.
    'let s = {};\ns &&= process.env;\nif (s.PUSH_SKIP) process.exit(0);',
    // A destructuring assignment takes `env` out of the process module.
    'let settings;\n({ env: settings } = process);\nif (settings.PUSH_SKIP) process.exit(0);',
    'let env;\n({ env } = process);\nif (env.PUSH_SKIP) process.exit(0);',
  ]) {
    it(`an assigned alias of the environment reads: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), ['PUSH_SKIP']);
    });
  }

  const destructuring: Array<[string, string[]]> = [
    ['let PUSH_SKIP;\n({ PUSH_SKIP } = process.env);', ['PUSH_SKIP']],
    ["let skip, probe;\n({ PUSH_SKIP: skip, ['PUSH_PROBE']: probe } = process.env);", ['PUSH_SKIP', 'PUSH_PROBE']],
    // `...rest` names no variable; the rest is read by name later, if at all.
    ['let rest;\n({ ...rest } = process.env);', []],
    // Destructuring anything but the environment reads none of it.
    ['let PUSH_SKIP;\n({ PUSH_SKIP } = { PUSH_SKIP: 1 });', []],
    // From the process module only `env` is the environment.
    ['let argv;\n({ argv } = process);\nif (argv.PUSH_SKIP) process.exit(0);', []],
    ['let settings;\n({ env: settings } = other);\nif (settings.PUSH_SKIP) process.exit(0);', []],
  ];
  for (const [source, found] of destructuring) {
    it(`a destructuring assignment reads what it takes: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), found);
    });
  }

  for (const source of ['echo PUSH_SKIP is retired', '[[ PUSH_SKIP == x ]] || exit 1', '(( count > 0 )) && echo "PUSH_SKIP"']) {
    it(`a bare name outside arithmetic reads nothing: ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), []);
    });
  }

  for (const source of ['const env: Record<string, string | undefined> = process.env;\nif (env.PUSH_SKIP) process.exit(0);', 'function gate(env: Record<string, string> = process.env) { return env.PUSH_SKIP; }']) {
    it(`a typed alias of the environment still reads: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), ['PUSH_SKIP']);
    });
  }

  it('an unterminated single quote blanks the rest of its line', () => {
    assert.deepEqual(names('.husky/pre-push', "echo 'it $PUSH_SKIP"), []);
  });

  for (const source of [
    "printf '%s\\n' \\$PUSH_SKIP",
    'echo "\\$PUSH_SKIP is gone"',
    'cat <<EOF\n\\$PUSH_SKIP\nEOF',
    // A string spans lines: its later lines are still inside it.
    "echo 'first\n$PUSH_SKIP\nlast'",
    "printf '%s\n' 'a\nb' 'c\n$PUSH_PROBE'",
  ]) {
    it(`an escaped or quoted dollar is no read: ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), []);
    });
  }

  for (const source of ['echo "\\\\$PUSH_SKIP"', 'echo "don\'t\nsee $PUSH_SKIP"', 'echo \'a\nb\'; echo "$PUSH_SKIP"', 'echo "a\\\n$PUSH_SKIP"']) {
    it(`a read survives escapes and multiline strings: ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), ['PUSH_SKIP']);
    });
  }

  it('a line inside a multiline string initialises nothing', () => {
    assert.deepEqual(names('.husky/pre-push', 'echo \'usage:\nPUSH_SKIP=0\n\'\n[ -n "$PUSH_SKIP" ] && exit 0'), ['PUSH_SKIP']);
  });

  for (const before of ["cat <<'EOF'\nPUSH_SKIP=0\nEOF", 'cat <<EOF\nPUSH_SKIP=0\nEOF', 'cat <<"EOF" >notes\nPUSH_SKIP=0\nEOF']) {
    it(`a heredoc body initialises nothing: ${j(before)}`, () => {
      assert.deepEqual(names('.husky/pre-push', `${before}\n[ -n "$PUSH_SKIP" ] && exit 0`), ['PUSH_SKIP']);
    });
  }

  for (const source of [
    'function check(env: { PUSH_SKIP: boolean }) { return env.PUSH_SKIP; }',
    'const env: Settings = load();\nif (env.PUSH_SKIP) process.exit(0);',
    'if (state.process.env.PUSH_SKIP) process.exit(0);',
    'const env = { PUSH_SKIP: false };\nif (env.PUSH_SKIP) process.exit(0);',
    'let env;\nif (env.PUSH_SKIP) process.exit(0);',
    'class Gate { check({ env }: { env: Settings }) { return env; } }',
  ]) {
    it(`an ordinary object is not the environment: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), []);
    });
  }

  const spellings: Array<[string, string]> = [
    ['scripts/gate.ts', 'function gate(env: NodeJS.ProcessEnv) { return env.PUSH_SKIP; }'],
    ['scripts/gate.mjs', 'function gate(env) { return env.PUSH_SKIP; }'],
    ['scripts/gate.ts', "import { env } from 'node:process';\nenv.PUSH_SKIP;"],
    ['scripts/gate.ts', "import { env as environment } from 'node:process';\nenvironment.PUSH_SKIP;"],
    ['scripts/gate.ts', "import proc from 'process';\nproc.env.PUSH_SKIP;"],
    ['scripts/gate.ts', "import * as proc from 'node:process';\nproc.env.PUSH_SKIP;"],
    ['scripts/gate.cjs', "const p = require('node:process');\np.env.PUSH_SKIP;"],
    ['scripts/gate.cjs', "const { env: e } = require('process');\ne.PUSH_SKIP;"],
    ['scripts/gate.ts', 'if (global.process.env.PUSH_SKIP) process.exit(0);'],
    ['scripts/gate.ts', 'const env = process.env;\nif (env.PUSH_SKIP) process.exit(0);'],
    ['scripts/gate.ts', 'function f() { const { env } = process; return env.PUSH_SKIP; }'],
  ];
  for (const [file, source] of spellings) {
    it(`the environment under another spelling still reads: ${file} ${j(source)}`, () => {
      assert.deepEqual(names(file, source), ['PUSH_SKIP']);
    });
  }

  for (const source of ["process.env.PUSH_SKIP = '0';", "(process.env.PUSH_SKIP) = '0';", "process.env['PUSH_PROBE']! = '';", 'delete process.env.PUSH_SKIP;']) {
    it(`writing a switch is not reading it: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), []);
    });
  }

  for (const source of ["process.env.PUSH_SKIP ??= '0';", "process.env.PUSH_SKIP += '0';", "const skip = (process.env.PUSH_SKIP = '0');\nif (process.env.PUSH_SKIP) process.exit(0);"]) {
    it(`a compound assignment, or a later read, still reads: ${j(source)}`, () => {
      assert.ok(names('scripts/gate.ts', source).length > 0);
    });
  }

  it('counts an assignment after a one-line branch has closed', () => {
    assert.deepEqual(names('.husky/pre-push', 'if x; then y; fi\nPUSH_SKIP=""\n[ -n "$PUSH_SKIP" ] && exit 0'), []);
  });

  for (const source of [
    'const { PUSH_SKIP } = process.env;',
    'const { other, PUSH_SKIP: skip } = process.env;',
    'const {\n  PUSH_PROBE,\n} = env;',
    "const environment = process.env;\nif (environment.PUSH_SKIP === '1') process.exit(0);",
    "const e = process.env;\nif (e['PUSH_SKIP']) process.exit(0);",
    'const environment = process.env;\nconst { PUSH_SKIP } = environment;',
    'const a = process.env;\nconst b = a;\nif (b.PUSH_SKIP) process.exit(0);',
    'const { env: e } = process;\nconst { PUSH_PROBE: probe } = e;',
  ]) {
    it(`reads a destructured or aliased switch: ${j(source)}`, () => {
      assert.equal(names('scripts/gate.ts', source).length, 1);
    });
  }

  for (const source of [
    "if (process?.['env']?.['PUSH_SKIP'] === '1') process.exit(0);",
    "if (process.env?. ['PUSH_SKIP']) process.exit(0);",
    "if ('PUSH_SKIP' in process.env) process.exit(0);",
    "const { ['PUSH_SKIP']: skip } = process.env;",
    'if ((process.env as Record<string, string>).PUSH_SKIP) process.exit(0);',
    "if (globalThis.process.env['PUSH_PROBE']) process.exit(0);",
  ]) {
    it(`reads a computed or optional access: ${j(source)}`, () => {
      assert.equal(names('scripts/gate.ts', source).length, 1);
    });
  }

  for (const source of [
    "process.env['GATE_' + 'SKIP'];",
    "process.env[('GATE_' + `SK`) + 'IP'];",
    "process.env[`GATE_${'SKIP'}`];",
    "process.env[`GA${'TE'}_${'SK'}IP`];",
    "const KEY = 'GATE_SKIP';\nprocess.env[KEY];",
    "const PART = 'SKIP';\nconst KEY = `GATE_${PART}` as const;\nprocess.env[KEY];",
    "if ('GATE_' + 'SKIP' in process.env) process.exit(0);",
    "if (('GATE_' + 'SKIP') in process.env) process.exit(0);",
    "const { ['GATE_' + 'SKIP']: skip } = process.env;",
    "process['e' + 'nv'].GATE_SKIP;",
    "globalThis['pro' + 'cess'].env.GATE_SKIP;",
  ]) {
    it(`resolves a constant key: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), ['GATE_SKIP']);
    });
  }

  it('resolves one constant at every read of it', () => {
    assert.deepEqual(findSwitchReads('scripts/gate.ts', "const KEY = 'GATE_SKIP';\nprocess.env[KEY];\nprocess.env[KEY];"), [
      { file: 'scripts/gate.ts', line: 2, name: 'GATE_SKIP' },
      { file: 'scripts/gate.ts', line: 3, name: 'GATE_SKIP' },
    ]);
  });

  for (const source of [
    // Not constant: the key is whatever runs put there.
    'declare const KEY: string;\nprocess.env[KEY];',
    'process.env[UNDECLARED];',
    "let KEY = 'GATE_SKIP';\nKEY = 'HOME';\nprocess.env[KEY];",
    'function read(KEY: string) { return process.env[KEY]; }',
    'process.env[`GATE_${mode}`];',
    "process.env['GATE_' + mode];",
    "process.env[mode + 'GATE_SKIP'];",
    "const { KEY } = { KEY: 'GATE_SKIP' };\nprocess.env[KEY];",
    'const KEY = 1;\nprocess.env[KEY];',
    // A constant that is not a switch name.
    "const KEY = 'GATE_' + 'SKIPPER';\nprocess.env[KEY];",
    "process.env['GATE_' - 'SKIP'];",
    // Its own initialiser, directly or through another: no value at all.
    'const A: string = A;\nprocess.env[A];',
    'const A: string = B;\nconst B: string = A;\nprocess.env[A];',
  ]) {
    it(`a key that is not a constant switch name reads nothing: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), []);
    });
  }

  for (const source of [
    'function check(process: { env: { PUSH_SKIP?: string } }) { return process.env.PUSH_SKIP; }',
    "const process = { env: { PUSH_SKIP: '' } };\nif (process.env.PUSH_SKIP) throw new Error();",
    'let process;\nif (process.env.PUSH_SKIP) throw new Error();',
    'function check(process: MyProcessLike) { return process.env.PUSH_SKIP; }',
    // A destructured `{ process }` declares the name too.
    'const { process } = { process: { env: { PUSH_SKIP: 1 } } };\nprocess.env.PUSH_SKIP;',
    'const { process } = settings;\nprocess.env.PUSH_SKIP;',
    'const { other: process } = globalThis;\nprocess.env.PUSH_SKIP;',
    "const { ['other']: process } = globalThis;\nprocess.env.PUSH_SKIP;",
  ]) {
    it(`a local named process is an ordinary object: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), []);
    });
  }

  const ownName: Array<[string, string]> = [
    ['scripts/gate.ts', 'function gate(process: NodeJS.Process) { return process.env.PUSH_SKIP; }'],
    ['scripts/gate.ts', 'function gate(process: typeof globalThis.process) { return process.env.PUSH_SKIP; }'],
    ['scripts/gate.mjs', 'function gate(process) { return process.env.PUSH_SKIP; }'],
    ['scripts/gate.ts', 'const process = globalThis.process;\nprocess.env.PUSH_SKIP;'],
    ['scripts/gate.ts', "const process: Settings = require('node:process');\nprocess.env.PUSH_SKIP;"],
    ['scripts/gate.ts', "import process from 'node:process';\nprocess.env.PUSH_SKIP;"],
    ['scripts/gate.ts', 'function process() {}\nprocess.env.PUSH_SKIP;'],
    // The local is out of scope: the read is the global's.
    ['scripts/gate.ts', 'function f(process: { env: object }) { return process; }\nprocess.env.PUSH_SKIP;'],
    // A member named `process` declares nothing the bare name resolves to.
    ['scripts/gate.ts', 'const o = { process: 1 };\nprocess.env.PUSH_SKIP;'],
    ['scripts/gate.ts', 'o.process = 1;\nprocess.env.PUSH_SKIP;'],
    ['scripts/gate.ts', 'class A { process() {} }\nprocess.env.PUSH_SKIP;'],
    // `{ process: p }` declares `p`, not `process`.
    ['scripts/gate.ts', 'const { process: p } = o;\nprocess.env.PUSH_SKIP;'],
    // Destructured from the global, or from a source not in view.
    ['scripts/gate.ts', 'const { process } = globalThis;\nprocess.env.PUSH_SKIP;'],
    ['scripts/gate.ts', 'const { process } = (global);\nprocess.env.PUSH_SKIP;'],
    ['scripts/gate.ts', "const { 'process': process } = globalThis;\nprocess.env.PUSH_SKIP;"],
    ['scripts/gate.ts', "const { ['process']: process } = globalThis;\nprocess.env.PUSH_SKIP;"],
    ['scripts/gate.ts', 'const { [key]: process } = globalThis;\nprocess.env.PUSH_SKIP;'],
    ['scripts/gate.ts', 'function f({ process }) { return process.env.PUSH_SKIP; }'],
    ['scripts/gate.ts', 'const [process] = list;\nprocess.env.PUSH_SKIP;'],
    ['scripts/gate.ts', 'const { a: { process } = settings } = o;\nprocess.env.PUSH_SKIP;'],
    ['scripts/gate.ts', 'let { process }: Settings;\nprocess.env.PUSH_SKIP;'],
  ];
  for (const [file, source] of ownName) {
    it(`process under its own name still reads: ${file} ${j(source)}`, () => {
      assert.deepEqual(names(file, source), ['PUSH_SKIP']);
    });
  }

  for (const source of [
    '// Removed process.env.PUSH_SKIP; the gate decides itself.',
    "console.log('set process.env.PUSH_SKIP no longer');",
    '/* const e = process.env; e.PUSH_SKIP */',
    'const note = `process.env.PUSH_PROBE is gone`;',
  ]) {
    it(`a mention in a comment or string is not a read: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), []);
    });
  }

  it('leaves destructuring of other names alone', () => {
    assert.deepEqual(names('scripts/gate.ts', 'const { HOME, CI } = process.env;'), []);
    // A numeric key names no variable.
    assert.deepEqual(names('scripts/gate.ts', 'const { 0: first } = process.env;'), []);
  });

  it('keeps an alias to its own scope', () => {
    assert.deepEqual(
      names('scripts/gate.ts', 'function a() { const settings = process.env; return settings.HOME; }\nfunction b(settings: { PUSH_SKIP?: string }) { if (settings.PUSH_SKIP) return; }'),
      [],
    );
    assert.deepEqual(names('scripts/gate.ts', 'function a() { const settings = process.env; if (settings.PUSH_SKIP) return; }'), ['PUSH_SKIP']);
  });

  it('does not treat a value read from the environment as an alias of it', () => {
    assert.deepEqual(names('scripts/gate.ts', 'const home = process.env.HOME;\nconst { PUSH_SKIP } = home;'), []);
  });

  it('reports the line', () => {
    assert.deepEqual(findSwitchReads('scripts/gate.sh', 'set -e\n\necho "$A_SKIP"'), [{ file: 'scripts/gate.sh', line: 3, name: 'A_SKIP' }]);
  });

  it('allows the setup switch in both files that read it, and nowhere else', () => {
    for (const file of PRODUCT_CONFIG.notAGate.SETUP_SKIP_MOBILE.files) {
      assert.deepEqual(names(file, 'if [ "$SETUP_SKIP_MOBILE" = 1 ]; then return; fi'), []);
      assert.deepEqual(names(file, 'os.getenv("SETUP_SKIP_MOBILE")'), [], 'a shell file reads no Python');
    }
    assert.deepEqual(names('scripts/setup.py', 'os.getenv("SETUP_SKIP_MOBILE")'), ['SETUP_SKIP_MOBILE']);
    assert.deepEqual(names('scripts/setup.ts', 'process.env.SETUP_SKIP_MOBILE'), ['SETUP_SKIP_MOBILE']);
    const own = readerFor(parseConfig(JSON.stringify({ ...PRODUCT_CONFIG, notAGate: { SETUP_SKIP_MOBILE: { files: ['scripts/setup.py', 'scripts/setup.ts', '.github/workflows/setup.yml'], reason: 'r' } } })));
    assert.deepEqual(own.findSwitchReads('scripts/setup.py', 'os.getenv("SETUP_SKIP_MOBILE")', ts), []);
    assert.deepEqual(own.findSwitchReads('scripts/setup.ts', 'process.env.SETUP_SKIP_MOBILE', ts), []);
    assert.deepEqual(own.findSwitchReads('.github/workflows/setup.yml', 'run: echo "$SETUP_SKIP_MOBILE"', ts), []);
  });
});

describe('findSwitchReads on shell, where bash reads', () => {
  for (const source of [
    // `<<<` is a here-string: the next line is code, not a heredoc body.
    'cat <<<\'EOF\'\n[ -n "$PUSH_SKIP" ] && exit 0',
    // A `#` inside a string an earlier line opened is text, not a comment.
    'echo "a\n# $PUSH_SKIP"',
    'echo "a\\" b # $PUSH_SKIP"',
    'echo "$PUSH_SKIP\n"',
    'echo "a\nb" $PUSH_SKIP',
    // A `#` glued to a word starts no comment.
    'echo a# $PUSH_SKIP',
    // A `$` closing a string an earlier line opened is no `$'…'` quote.
    "printf '%s' \"a\n$\"'x\\' $PUSH_SKIP",
    "echo $'a\\'b' $PUSH_SKIP",
    // An ANSI-C delimiter ends at its unescaped text.
    "cat <<$'E\\'F'\n$GATE_SKIP\nE'F\necho \"$PUSH_SKIP\"",
    // An escaped delimiter ends its heredoc too.
    'cat <<\\EOF\nbody\nEOF\n[ -n "$PUSH_SKIP" ] && exit 0',
  ]) {
    it(`reads ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), ['PUSH_SKIP']);
    });
  }

  for (const source of [
    'echo "$\\{PUSH_SKIP}"',
    'echo $\\{PUSH_SKIP}',
    "echo $''PUSH_SKIP",
    'echo "a" # $PUSH_SKIP',
    'echo "" # $PUSH_SKIP',
    'echo "a" \'$PUSH_SKIP\'',
    'echo "a\nb" # $PUSH_SKIP',
    'echo "a\\\\" # $PUSH_SKIP',
    'echo "a\\ b" # $PUSH_SKIP',
    "echo $'a\\'b' # $PUSH_SKIP",
    "echo $'a\n$PUSH_SKIP'",
    // In a heredoc body `$\$` is two dollars, no read.
    'cat <<EOF\n$\\$PUSH_SKIP\nEOF',
  ]) {
    it(`does not read ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), []);
    });
  }

  const closed: Array<[string, string]> = [
    ['a brace group', '{\n:\n}'],
    ['a subshell', '(\n:\n)'],
    ['a branch closed before a comment', 'if x; then\n:\nfi # done'],
  ];
  for (const [label, before] of closed) {
    it(`counts an initialisation after ${label} has closed`, () => {
      assert.deepEqual(names('.husky/pre-push', `${before}\nPUSH_SKIP=0\n[ -n "$PUSH_SKIP" ] && exit 0`), []);
    });
  }

  const none: Array<[string, string]> = [
    // `fi` glued to quoted text is a word, not the end of the branch.
    ['a branch still open', 'if true; then echo "x"fi\nPUSH_SKIP=0\nfi'],
    // `true \` joins the next line: the assignment is an argument.
    ['a continued command', 'true \\\nPUSH_SKIP=0'],
    // The heredoc's delimiter is data, though it looks like an assignment.
    ['a heredoc delimiter', "cat <<'PUSH_SKIP=0'\nbody\nPUSH_SKIP=0"],
    // The list `cat <<EOF &&` goes on after the heredoc's lines.
    ['a list across a heredoc', 'cat <<EOF &&\nbody\nEOF\nPUSH_SKIP=0'],
    // The initialisation reads the caller's value in its subscript.
    ['its own subscript', 'PUSH_SKIP=${modes[PUSH_SKIP]}'],
  ];
  for (const [label, before] of none) {
    it(`counts no initialisation in ${label}`, () => {
      assert.deepEqual(names('.husky/pre-push', `${before}\n[ -n "$PUSH_SKIP" ] && exit 0`), ['PUSH_SKIP']);
    });
  }

  for (const before of ['gate() (\nPUSH_SKIP=0\n)', 'gate()(\nPUSH_SKIP=0\n)', 'function gate() (\nPUSH_SKIP=0\n)']) {
    it(`a subshell function body initialises nothing: ${j(before)}`, () => {
      assert.deepEqual(names('.husky/pre-push', `${before}\n[ -n "$PUSH_SKIP" ] && exit 0`), ['PUSH_SKIP']);
    });
  }

  it('counts an initialisation after a subshell function has closed', () => {
    assert.deepEqual(names('.husky/pre-push', 'gate() (\n:\n)\nPUSH_SKIP=0\n[ -n "$PUSH_SKIP" ] && exit 0'), []);
  });

  it('reads every bare name in one arithmetic context', () => {
    assert.deepEqual(names('.husky/pre-push', '(( PUSH_SKIP + GATE_SKIP )) && exit 0'), ['PUSH_SKIP', 'GATE_SKIP']);
  });
});

describe('findSwitchReads on workflows', () => {
  for (const source of ['      run: echo a# $PUSH_SKIP', "      run: echo 'a # b' $PUSH_SKIP", '      run: echo "$PUSH_SKIP\\']) {
    it(`reads ${j(source)}`, () => {
      assert.deepEqual(names('.github/workflows/ci.yml', source), ['PUSH_SKIP']);
    });
  }

  for (const source of ['# ${{ env.CI_SKIP }}', '      run: echo "a" # $PUSH_SKIP', '      run: echo "a\\" b" # $PUSH_SKIP', '      run: echo "a\\ b" # $PUSH_SKIP']) {
    it(`does not read ${j(source)}`, () => {
      assert.deepEqual(names('.github/workflows/ci.yml', source), []);
    });
  }
});

describe('findSwitchReads on Python', () => {
  for (const source of [
    // A `'` string ends at its line: the next line is code.
    "x = 'open\nb = os.environ.get('PUSH_SKIP')",
    "x = 'a\\'b' + os.environ.get('PUSH_SKIP')",
    "os.environ.get(r'PUSH_SKIP')",
  ]) {
    it(`reads ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.py', source), ['PUSH_SKIP']);
    });
  }

  it('keeps the lines of an emptied string', () => {
    assert.deepEqual(findSwitchReads('scripts/gate.py', "'''doc\nmore'''\nos.getenv('PUSH_SKIP')"), [{ file: 'scripts/gate.py', line: 3, name: 'PUSH_SKIP' }]);
  });

  for (const source of [
    'print(f"os.environ.get(\'PUSH_SKIP\') for {task}")',
    'print(f\'{{os.environ.get("PUSH_SKIP")}} {task}\')',
    'print(f"{note} os.getenv(\'PUSH_SKIP\') }}")',
    // A string inside the braces is text too.
    "print(f'''{ \"os.environ.get('PUSH_SKIP')\" }''')",
    "print(f'''{ {'a': \"os.getenv('PUSH_SKIP')\"}['a'] }''')",
    // A `{` that never closes is text, and so is all after it.
    'print(f"{ os.getenv(\'PUSH_SKIP\')")',
  ]) {
    it(`the text of an f-string is not a read: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.py', source), []);
    });
  }

  for (const source of [
    'print(f"{os.environ.get(\'PUSH_SKIP\')}")',
    'print(f\'{task} {os.getenv("PUSH_SKIP")!r:>{width}}\')',
    'print(f\'{ {"k": os.getenv("PUSH_SKIP")} }\')',
    'print(f\'a}}b {os.environ["PUSH_SKIP"]}\')',
    // Braces nested two deep, and a quoted brace, inside one field.
    "x = f\"{os.getenv('PUSH_SKIP') and {'a': {'b': 1}}}\"",
    "x = f\"{ {'a': {'x}': 1}} or os.getenv('PUSH_SKIP')}\"",
    'x = f\'{ {"}"} and os.getenv("PUSH_SKIP")}\'',
    // A `{` that never closes is text; the field after it is still code.
    'x = f\'{ {os.getenv("PUSH_SKIP")}\'',
    "os.environ.get(f'PUSH_SKIP')",
    "os.environ.get(rf'PUSH_SKIP')",
    // An empty f-string is nothing: the key is the literal after it.
    "os.environ.get(f'' 'PUSH_SKIP')",
  ]) {
    it(`code in an f-string still reads: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.py', source), ['PUSH_SKIP']);
    });
  }

  it('keeps the lines of an f-string', () => {
    assert.deepEqual(findSwitchReads('scripts/gate.py', "x = f'''text\n{\n  os.getenv('A_SKIP')\n} more\n'''\nos.getenv('B_SKIP')"), [
      { file: 'scripts/gate.py', line: 3, name: 'A_SKIP' },
      { file: 'scripts/gate.py', line: 6, name: 'B_SKIP' },
    ]);
  });

  it('reports reads in line order, whichever pattern found them', () => {
    assert.deepEqual(findSwitchReads('scripts/gate.py', "os.getenv('A_SKIP')\nos.environ.get('B_SKIP')"), [
      { file: 'scripts/gate.py', line: 1, name: 'A_SKIP' },
      { file: 'scripts/gate.py', line: 2, name: 'B_SKIP' },
    ]);
  });
});

describe('findSwitchReads on scripts', () => {
  it('reports the line', () => {
    assert.deepEqual(findSwitchReads('scripts/gate.ts', '\nif (process.env.PUSH_SKIP) process.exit(0);'), [{ file: 'scripts/gate.ts', line: 2, name: 'PUSH_SKIP' }]);
  });

  for (const source of [
    'if (foo.env.PUSH_SKIP) process.exit(0);',
    "import proc from 'node:process';\nconst foo = { env: {} };\nif (foo.env.PUSH_SKIP) proc.exit(0);",
    'if (globalThis.foo.env.PUSH_SKIP) process.exit(0);',
    'if (config.settings.env.PUSH_SKIP) process.exit(0);',
    'if (process.argv.PUSH_SKIP) process.exit(0);',
    "import { argv } from 'node:process';\nif (argv.env.PUSH_SKIP) process.exit(0);",
    'const { argv } = process;\nif (argv.PUSH_SKIP) process.exit(0);',
  ]) {
    it(`another object is not the environment: ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), []);
    });
  }

  for (const source of [
    "import { default as proc } from 'node:process';\nproc.env.PUSH_SKIP;",
    // Assigned to a local, the switch is read.
    'let skip;\nskip = process.env.PUSH_SKIP;',
  ]) {
    it(`reads ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), ['PUSH_SKIP']);
    });
  }

  it('reads a .tsx file as TSX', () => {
    assert.deepEqual(names('scripts/gate.tsx', 'const a = <b>{process.env.PUSH_SKIP}</b>;'), ['PUSH_SKIP']);
  });

  it('builds its checker from the gate file alone', () => {
    const { seen, compiler } = watchedCompiler();
    assert.deepEqual(names('scripts/gate.ts', "/// <reference types=\"node\" />\nimport proc from 'node:process';\nimport { a } from './lib.ts';\nproc.env.PUSH_SKIP;", compiler), ['PUSH_SKIP']);
    // The file itself, and the directories that hold it; no lib, no import,
    // no `@types` package.
    const gate = '/gate/scripts/gate.ts';
    assert.ok(seen.asked.has(gate));
    assert.deepEqual(
      [...seen.asked].filter((name) => !gate.startsWith(name)),
      [],
    );
  });

  it('builds no checker for a file that aliases nothing', () => {
    const { seen, compiler } = watchedCompiler();
    assert.deepEqual(names('scripts/gate.ts', 'if (foo.PUSH_SKIP) process.exit(0);', compiler), []);
    assert.equal(seen.built, 0);
  });

  it('builds no checker for process where nothing declares that name', () => {
    const { seen, compiler } = watchedCompiler();
    assert.deepEqual(names('scripts/gate.ts', 'const skip = process.env.PUSH_SKIP;\nif (skip) process.exit(0);', compiler), ['PUSH_SKIP']);
    assert.equal(seen.built, 0);
  });

  it('flips when the guard is removed: an initialisation-free read in a hook', () => {
    // A hook without its top-level initialisation is exactly the bypass the
    // check exists for.
    assert.deepEqual(names('.husky/pre-push', 'if [ -n "$TOOLING_DOCKER_SKIP" ]; then echo skipped; exit 0; fi'), ['TOOLING_DOCKER_SKIP']);
  });
});

describe('isGateCode', () => {
  const cases: Array<[string, boolean]> = [
    ['.husky/pre-commit', true],
    ['scripts/lib/git_safety.py', true],
    ['.claude/hooks/bash-guard.sh', true],
    ['.github/workflows/ci.yml', true],
    ['scripts/validations/security/check-env-gate-switches.test.ts', false],
    ['scripts/lib/test_worktree_boundary.py', false],
    ['.codex/hooks/guard.py', false],
    ['.claude/hooks/bash-guard.test.sh', false],
    ['scripts/validations/fixtures/gate.sh', false],
    ['apps/server/src/main.ts', false],
    ['scripts/README.md', false],
    ['scripts/notes.txt', false],
  ];
  for (const [file, expected] of cases) {
    it(`${file} → ${String(expected)}`, () => {
      assert.equal(reader.isGateCode(file), expected);
    });
  }
});

describe('findSwitchReads on Python, through aliases and setdefault', () => {
  for (const source of [
    "from os import environ as env\nif env.get('PUSH_SKIP'): sys.exit(0)",
    "from os import environ as env\nif env['PUSH_SKIP']: sys.exit(0)",
    "from os import getenv as g\nif g('PUSH_SKIP'): sys.exit(0)",
    "from os import (\n    environ as e,\n    path,\n)\ne.get('PUSH_SKIP')",
    "from os import path, getenv as read_env  # noqa\nread_env(\"PUSH_SKIP\")",
    "import os as o\no.environ.get('PUSH_SKIP')",
    // setdefault returns the caller's value when there is one.
    "os.environ.setdefault('PUSH_SKIP', '0')",
    "from os import environ as env\nenv.setdefault('PUSH_SKIP', '0')",
  ]) {
    it(`reads ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.py', source), ['PUSH_SKIP']);
    });
  }

  for (const source of [
    "from os import environ as env\nenv['PUSH_SKIP'] = '1'",
    "from os import environ as env\ndel env['PUSH_SKIP']",
    "from os import path as p\np.get('PUSH_SKIP')",
    "from os import getenv as g\nself.g('PUSH_SKIP')",
    "from os import getenv as g\nbig('PUSH_SKIP')",
    "# from os import environ as env\nenv.get('PUSH_SKIP')",
    "print('from os import environ as env')\nenv.get('PUSH_SKIP')",
  ]) {
    it(`does not read ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.py', source), []);
    });
  }

  for (const source of [
    // Membership tells the gate whether the caller set the switch.
    "if 'PUSH_SKIP' in os.environ: sys.exit(0)",
    'if "PUSH_SKIP" not in os.environ:\n    run()',
    "if 'PUSH_SKIP' in os.environ.keys(): sys.exit(0)",
    "from os import environ as env\nif 'PUSH_SKIP' in env: sys.exit(0)",
    // pop returns the caller's value as it drops it.
    "if os.environ.pop('PUSH_SKIP', None): sys.exit(0)",
    "from os import environ as env\nenv.pop('PUSH_SKIP')",
    // The bytes environment.
    "os.getenvb(b'PUSH_SKIP')",
    "os.environb[b'PUSH_SKIP']",
    "from os import environb as eb\neb.get(b'PUSH_SKIP')",
    "from os import getenvb as gb\ngb(b'PUSH_SKIP')",
    // A copy holds the caller's values.
    "os.environ.copy()['PUSH_SKIP']",
    "dict(os.environ)['PUSH_SKIP']",
    "dict(os.environ).get('PUSH_SKIP')",
    "if 'PUSH_SKIP' in dict(os.environ): sys.exit(0)",
    "from os import environ as env\nenv.copy().get('PUSH_SKIP')",
    // A name assigned the environment, a copy of it, or getenv.
    "env = os.environ\nif env.get('PUSH_SKIP'): sys.exit(0)",
    "snapshot = os.environ.copy()  # keep\nsnapshot['PUSH_SKIP']",
    "snapshot = dict(os.environ)\nif 'PUSH_SKIP' in snapshot: sys.exit(0)",
    "read = os.getenv\nread('PUSH_SKIP')",
  ]) {
    it(`reads ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.py', source), ['PUSH_SKIP']);
    });
  }

  for (const source of [
    "if 'PUSH_SKIP' in names: sys.exit(0)",
    "from os import environ as env\nif 'PUSH_SKIP' in envelope: sys.exit(0)",
    "if 'PUSH_SKIP' in other.environment: sys.exit(0)",
    "print(\"'PUSH_SKIP' in os.environ\")",
    "env = os.environ\nenv['PUSH_SKIP'] = '1'",
    "os.environ.copy()['PUSH_SKIP'] = '1'",
    "env = os.environ.get('HOME')\nenv.get('PUSH_SKIP')",
    "env = settings\nenv.get('PUSH_SKIP')",
  ]) {
    it(`does not read ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.py', source), []);
    });
  }

  it('reads through a name imported and assigned once, and through environ under its own name once', () => {
    assert.deepEqual(names('scripts/gate.py', "from os import environ as env\nenv = os.environ\nenv.get('PUSH_SKIP')"), ['PUSH_SKIP']);
    assert.deepEqual(names('scripts/gate.py', "from os import environ as environ, getenv as getenv\nenviron.get('PUSH_SKIP')\ngetenv('PUSH_PROBE')"), ['PUSH_SKIP', 'PUSH_PROBE']);
  });

  it('reports a membership read at its line, once', () => {
    assert.deepEqual(findSwitchReads('scripts/gate.py', "import os\n\nif 'PUSH_SKIP' in os.environ: pass"), [{ file: 'scripts/gate.py', line: 3, name: 'PUSH_SKIP' }]);
  });

  it('reports an alias read at its line', () => {
    assert.deepEqual(findSwitchReads('scripts/gate.py', "from os import getenv as g\n\ng('PUSH_SKIP')"), [{ file: 'scripts/gate.py', line: 3, name: 'PUSH_SKIP' }]);
  });
});

describe('findSwitchReads on scripts, through nested destructuring', () => {
  for (const [source, found] of [
    ['const { env: { PUSH_SKIP } } = process;', ['PUSH_SKIP']],
    ['const { env: { PUSH_SKIP: skip } } = process;', ['PUSH_SKIP']],
    ['const { env: { PUSH_SKIP } = {} } = process;', ['PUSH_SKIP']],
    ["const { env: { ['PUSH_' + 'PROBE']: probe, HOME } } = require('node:process');", ['PUSH_PROBE']],
    ['const { process: { env: { PUSH_SKIP } } } = globalThis;', ['PUSH_SKIP']],
    ['let skip;\n({ env: { PUSH_SKIP: skip } } = process);', ['PUSH_SKIP']],
    ['const { env: { HOME } } = process;', []],
    ['const { argv: { PUSH_SKIP } } = process;', []],
    ['const { env: { PUSH_SKIP } } = settings;', []],
    ['const { other: { env: { PUSH_SKIP } } } = globalThis;', []],
    ['let skip;\n({ argv: { PUSH_SKIP: skip } } = process);', []],
  ] as const) {
    it(`${found.length > 0 ? 'reads' : 'does not read'} ${j(source)}`, () => {
      assert.deepEqual(names('scripts/gate.ts', source), [...found]);
    });
  }
});

describe('findSwitchReads on shell, where a name is read without $', () => {
  for (const source of [
    'printenv PUSH_SKIP && exit 0',
    'if [ "$(printenv HOME PUSH_SKIP)" ]; then exit 0; fi',
    '[[ -v PUSH_SKIP ]] && exit 0',
    'if [[ -n "$CI" && -v PUSH_SKIP ]]; then exit 0; fi',
    '[ -v PUSH_SKIP ] && exit 0',
    'test -v PUSH_SKIP && exit 0',
    'if ! test -v PUSH_SKIP; then :; else exit 0; fi',
  ]) {
    it(`reads ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), ['PUSH_SKIP']);
    });
  }

  for (const source of [
    'grep -v PUSH_SKIP log.txt',
    'echo printenv',
    '# printenv PUSH_SKIP',
    "echo '[[ -v PUSH_SKIP ]]'",
    // The script's own top-level decision, as for `$PUSH_SKIP`.
    'PUSH_SKIP=""\n[[ -v PUSH_SKIP ]] && exit 0',
    'PUSH_SKIP=0\nprintenv PUSH_SKIP',
  ]) {
    it(`does not read ${j(source)}`, () => {
      assert.deepEqual(names('.husky/pre-push', source), []);
    });
  }
});

describe('listFiles and readGate on symlinks', () => {
  it('marks a staged symlink by its index mode', () => {
    const out = ':000000 100644 0000000 1111111 A\0scripts/a.sh\0:100644 120000 2222222 3333333 T\0scripts/b.sh\0';
    const listed = listFiles({ git: { run: () => out }, read: () => '' }, 'staged');
    assert.deepEqual(listed, [
      { file: 'scripts/a.sh', symlink: false },
      { file: 'scripts/b.sh', symlink: true },
    ]);
  });

  it('refuses a symlink in the index or the working tree: its target is unchecked', () => {
    const reads: Reads = {
      git: { run: () => 'target.sh' },
      read: () => {
        throw Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' });
      },
    };
    assert.throws(() => readGate(reads, 'staged', { file: 'scripts/b.sh', symlink: true }), (e: unknown) => e instanceof UnreadableGateFile && e.message === 'scripts/b.sh is a symlink in the index; its target is unchecked');
    assert.throws(() => readGate(reads, 'tree', { file: 'scripts/b.sh', symlink: false }), (e: unknown) => e instanceof UnreadableGateFile && e.message === 'scripts/b.sh is a symlink in the working tree; its target is unchecked');
  });
});
