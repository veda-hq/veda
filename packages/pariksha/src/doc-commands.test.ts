import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { documentedCommands, NPX_VALUE_OPTIONS, npxCall, shellWords, simpleCommands, withoutAssignments } from './doc-commands.ts';
import { CONFIG } from './doc-references.fixture.test.ts';

const commandsOf = (content: string) => documentedCommands('x.md', content, CONFIG.exemptMarker);

describe('fixed vocabularies', () => {
  it('knows which npx options take a value', () => {
    assert.deepEqual(NPX_VALUE_OPTIONS, new Set(['--package', '-p', '--cache', '--userconfig', '--shell', '--call', '-c', '--workspace', '-w']));
  });

  // The declared shell fences are internal: a script path is a command only in one of them.
  it('reads these fences as declared shell, and no other', () => {
    // An info word is read without case, as the source reads it.
    for (const fence of ['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'BASH']) {
      assert.deepEqual(
        commandsOf(`\`\`\`${fence}\nscripts/x.ts --a\n\`\`\`\n`).map((c) => c.words),
        [['scripts/x.ts', '--a']],
        fence,
      );
    }
    for (const fence of ['', 'text', 'js', 'bash-session']) {
      assert.deepEqual(commandsOf(`\`\`\`${fence}\nscripts/x.ts --a\n\`\`\`\n`), [], fence);
    }
  });
});

describe('shellWords', () => {
  const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['joins adjacent quoted and bare parts', `--mode="a b"'c'd`, ['--mode=a bcd']],
    ['keeps an empty quoted word', `a '' "" b`, ['a', '', '', 'b']],
    ['drops a backslash outside quotes', 'a\\ b \\"c', ['a b', '"c']],
    ['drops a backslash in double quotes only before $ ` " \\', '"\\$ \\` \\" \\\\ \\a"', ['$ ` " \\ \\a']],
    ['keeps a backslash in single quotes', "'a\\' b", ['a\\', 'b']],
    ['keeps a quote that never closes', `"a b 'c`, ['"a', 'b', "'c"]],
    ['keeps a trailing backslash', 'a\\', ['a\\']],
    // `$'…'` is ANSI-C quoting, decoded before the program sees it.
    ['decodes an ANSI-C hex escape', "$'\\x2d\\x2dx'", ['--x']],
    ['decodes ANSI-C octal, unicode and control escapes', "$'\\055\\u2d\\U0000002d\\cA\\455'", ['---\u0001-']],
    ['keeps an ANSI-C escape it does not know', "$'\\q\\x\\c'", ['\\q\\x\\c']],
    ['keeps a code point past Unicode as written', "$'\\UFFFFFFFF' $'\\U0010FFFF'", ['\\UFFFFFFFF', '\u{10FFFF}']],
    ['decodes the named ANSI-C escapes', "$'\\e\\\\\\''", ["\u001b\\'"]],
    ['decodes every other named ANSI-C escape', `$'\\a\\b\\E\\f\\n\\r\\t\\v\\"\\?'`, ['\u0007\b\u001b\f\n\r\t\v"?']],
    ['ends an ANSI-C string at its NUL', "a$'b\\0c'd", ['abd']],
    ['reads an escaped quote inside ANSI-C', "$'a\\' b' c", ["a' b", 'c']],
    ['drops the $ of a locale string', '$"--x y"', ['--x y']],
    ['keeps an escaped $ before a quote', "\\$'x'", ['$x']],
  ];
  for (const [label, text, words] of cases) {
    it(`shell words: ${label}`, () => {
      assert.deepEqual(shellWords(text), words);
    });
  }
});

describe('withoutAssignments', () => {
  it('drops leading NAME=value words only', () => {
    assert.deepEqual(withoutAssignments(['FOO=1', 'B_2=', 'x', 'C=3']), ['x', 'C=3']);
    assert.deepEqual(withoutAssignments(['foo=1', 'x']), ['foo=1', 'x']);
    assert.deepEqual(withoutAssignments(['FOO=1']), []);
    assert.deepEqual(withoutAssignments([]), []);
  });
});

describe('simpleCommands', () => {
  const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['every operator', 'a && b || c ; d | e', ['a', 'b', 'c', 'd', 'e']],
    ['operators without blanks', 'a||b|c&&d;e', ['a', 'b', 'c', 'd', 'e']],
    ['a trailing `;`', 'a;', ['a', '']],
    ['quoted operators', `a 'b;c' "d && e" 'f|g'`, [`a 'b;c' "d && e" 'f|g'`]],
    ['escaped operators', 'a\\;b \\| c\\&\\& d', ['a\\;b \\| c\\&\\& d']],
    ['an escaped backslash before one', 'a\\\\;b', ['a\\\\', 'b']],
    ['outer blanks', '  a  ;\tb ', ['a', 'b']],
    ['an escaped blank at the end', '  a \\\t  ; b', ['a \\\t', 'b']],
    ['an escaped backslash, then blanks', 'a\\\\  ', ['a\\\\']],
  ];
  for (const [label, line, commands] of cases) {
    it(`simple commands: ${label}`, () => {
      assert.deepEqual(simpleCommands(line), commands);
    });
  }
});

describe('npxCall', () => {
  const cases: ReadonlyArray<readonly [readonly string[], string | undefined]> = [
    [['npx', '-c', 'tsx x.ts'], 'tsx x.ts'],
    [['npx', '--call', 'a; b'], 'a; b'],
    [['npx', '--call=tsx x.ts'], 'tsx x.ts'],
    [['npx', '--yes', '-p', 'tsx', '-c', 'tsx x.ts'], 'tsx x.ts'],
    [['npx', '-p', '-c', 'tsx x.ts'], undefined],
    // npm refuses a call with words after it.
    [['npx', '-c', 'tsx', 'x.ts'], undefined],
    [['npx', '--call=tsx', 'x.ts'], undefined],
    [['npx', '-c'], undefined],
    // npm reads an empty call as none.
    [['npx', '--call='], undefined],
    [['npx', '-c', ''], undefined],
    [['npx', 'tsx', '-c', 'x'], undefined],
    [['npx', '--callx', 'tsx'], undefined],
    [['node', '-c', 'x'], undefined],
  ];
  for (const [words, call] of cases) {
    it(`reads the call of ${JSON.stringify(words)}`, () => {
      assert.equal(npxCall(words), call);
    });
  }
});

describe('documentedCommands', () => {
  // A call of several commands, or none an interpreter runs alone, went unchecked.
  it('reads the commands an npx --call runs, its cd kept inside it', () => {
    assert.deepEqual(
      commandsOf(['```bash', "npx -c 'echo ok; FOO=1 tsx a.ts --x'", "npx --yes --call='cd b && tsx c.ts' && pnpm d", 'npx -c tsx e.ts', '```', "Run `npx -c 'tsx f.ts'`."].join('\n')).map((c) => [c.line, c.words, c.cwd, c.fenced]),
      [
        [2, ['echo', 'ok'], '', true],
        [2, ['tsx', 'a.ts', '--x'], '', true],
        [3, ['tsx', 'c.ts'], 'b', true],
        [3, ['pnpm', 'd'], '', true],
        [4, ['npx', '-c', 'tsx', 'e.ts'], '', true],
        [6, ['tsx', 'f.ts'], '', false],
      ],
    );
  });

  it('splits shell words and documented commands, tracking cd', () => {
    assert.deepEqual(shellWords(`a "b c" 'd e' f`), ['a', 'b c', 'd e', 'f']);
    const commands = commandsOf(['```bash', 'cd apps/server && FOO=1 pnpm test \\', '  --run', '```', ''].join('\n'));
    assert.deepEqual(commands, [
      {
        file: 'x.md',
        line: 2,
        words: ['pnpm', 'test', '--run'],
        text: 'FOO=1 pnpm test   --run',
        cwd: 'apps/server',
        fenced: true,
      },
    ]);
  });

  it('splits a fenced command at its comment, prompt and separators', () => {
    assert.deepEqual(
      commandsOf(['```bash', '$ pnpm a # c', 'FOO=1 pnpm b;', 'pnpm c && FOO=1', 'cd . && pnpm d', 'echo hi', '```', '---', 'Run `pnpm e`.', '`pnpm f` doc-ref-ok: example', ''].join('\n')).map((c) => [c.line, c.words, c.cwd, c.fenced]),
      [
        [2, ['pnpm', 'a'], '', true],
        [3, ['pnpm', 'b'], '', true],
        [4, ['pnpm', 'c'], '', true],
        [5, ['pnpm', 'd'], '', true],
        [9, ['pnpm', 'e'], '', false],
      ],
    );
    assert.deepEqual(commandsOf('---\nrun: `pnpm e`\n---\n'), []);
  });

  // Comments and continuations as bash reads them; the bash differential
  // (doc-commands.differential.test.ts) samples the rest.
  const QUOTED_LINES = [
    '```bash',
    `pnpm a '#' "x # y" b # c`,
    'pnpm a \\# b',
    'pnpm a;# node b',
    'pnpm a # c \\',
    'tsx b',
    'pnpm a\\\\',
    'tsx b',
    'pnpm a\\',
    '#b c',
    'pnpm a \\',
    '  # c',
    'tsx b',
    '$ pnpm x \\ ',
    '\\',
    'pnpm y',
    'pnpm a\\\\\\',
    'b',
    'pnpm a\\\\\\\\\\',
    'b',
    'pnpm a\\\\b\\\\',
    'tsx c',
    'pnpm a\\\\b \\',
    'c',
    'pnpm a\\;b',
    'tsx c',
    '```',
    '',
  ];
  const QUOTED_COMMANDS = [
    [2, `pnpm a '#' "x # y" b`],
    [3, 'pnpm a \\# b'],
    [4, 'pnpm a'],
    [5, 'pnpm a'],
    [6, 'tsx b'],
    [7, 'pnpm a\\\\'],
    [8, 'tsx b'],
    [9, 'pnpm a#b c'],
    [11, 'pnpm a'],
    [13, 'tsx b'],
    [14, 'pnpm x \\ '],
    [15, 'pnpm y'],
    [17, 'pnpm a\\\\b'],
    [19, 'pnpm a\\\\\\\\b'],
    [21, 'pnpm a\\\\b\\\\'],
    [22, 'tsx c'],
    [23, 'pnpm a\\\\b c'],
    [25, 'pnpm a\\;b'],
    [26, 'tsx c'],
  ];

  for (const [label, eol] of [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ] as const) {
    it(`ends a fenced command at its comment, as bash does (${label})`, () => {
      assert.deepEqual(
        commandsOf(QUOTED_LINES.join(eol)).map((c) => [c.line, c.text]),
        QUOTED_COMMANDS,
      );
    });
  }

  for (const fence of ['bash', 'sh', 'shell', 'zsh', 'console', 'terminal']) {
    it(`takes a script path as the command in a ${fence} fence`, () => {
      assert.deepEqual(
        commandsOf(`\`\`\`${fence}\nscripts/x.ts --a\n\`\`\`\n`).map((c) => c.words),
        [['scripts/x.ts', '--a']],
      );
    });
  }

  // A script path ending at a separator was no command.
  const separated: ReadonlyArray<readonly [string, readonly (readonly string[])[]]> = [
    ['scripts/x.ts; echo done', [['scripts/x.ts'], ['echo', 'done']]],
    ['scripts/x.ts&& echo done', [['scripts/x.ts'], ['echo', 'done']]],
    ['scripts/x.ts| cat', [['scripts/x.ts'], ['cat']]],
    ['scripts/x.tsx; echo done', []],
  ];
  for (const [line, words] of separated) {
    it(`takes \`${line}\` in a bash fence as its commands`, () => {
      assert.deepEqual(
        commandsOf(`\`\`\`bash\n${line}\n\`\`\`\n`).map((c) => c.words),
        words,
      );
    });
  }

  // Each fence line was read from the root.
  it('carries cd across the lines of one fence only', () => {
    assert.deepEqual(
      commandsOf(
        [
          '```bash',
          'cd apps/mobile',
          'bash ../../scripts/x.sh --staged',
          'cd ios && echo hi',
          '',
          'pnpm a',
          'cd x && pnpm z # doc-ref-ok: example',
          'pnpm y',
          'cd /tmp/a && pnpm w',
          '```',
          '```bash',
          'pnpm b',
          '```',
          '```bash',
          'cd apps/web',
          '```',
          'Run `pnpm c` or `cd docs && pnpm d`, then `pnpm e`.',
          '```sh',
          'pnpm f',
          '```',
        ].join('\n'),
      ).map((c) => [c.line, c.words[0], c.cwd]),
      [
        [3, 'bash', 'apps/mobile'],
        // `echo` makes line 4 no command to judge; its `cd` still moves.
        [6, 'pnpm', 'apps/mobile/ios'],
        // Line 7 is exempt, its command not judged; its `cd` still moves.
        [8, 'pnpm', 'apps/mobile/ios/x'],
        // An absolute operand replaces the directory, not nested under it.
        [9, 'pnpm', '/tmp/a'],
        [12, 'pnpm', ''],
        [17, 'pnpm', ''],
        [17, 'pnpm', 'docs'],
        [17, 'pnpm', ''],
        [19, 'pnpm', ''],
      ],
    );
  });

  // A closer followed at once by an opener: both marker lines are dropped,
  // so the two fences' lines are never adjacent, and neither a `\` nor a
  // `cd` crosses from one to the next.
  it('keeps back-to-back fences apart', () => {
    assert.deepEqual(
      commandsOf('```bash\ncd apps/mobile\npnpm a \\\n```\n```bash\ntsx b\n```\n').map((c) => [c.line, c.words, c.cwd]),
      [
        [3, ['pnpm', 'a', '\\'], 'apps/mobile'],
        [6, ['tsx', 'b'], ''],
      ],
    );
  });

  // `cd -P /repo` moved to the directory `-P`.
  const cdCases: ReadonlyArray<readonly [string, string]> = [
    ['cd -P a', 'a'],
    ['cd -L -P a', 'a'],
    ['cd -eP a', 'a'],
    ['cd -@ a', 'a'],
    ['cd -- -a', '-a'],
    ['cd -P -- a', 'a'],
    ['cd -x a', '-x'],
    ['cd -Px a', '-Px'],
    ['cd -P', ''],
    ['cd --', ''],
  ];
  for (const [line, cwd] of cdCases) {
    it(`reads the directory of \`${line}\` past its options`, () => {
      assert.deepEqual(
        commandsOf(`\`\`\`bash\n${line}\npnpm x\n\`\`\`\n`).map((c) => c.cwd),
        [cwd],
      );
    });
  }

  it('ends a continuation at its fence, or at the end of the text', () => {
    assert.deepEqual(
      commandsOf('```bash\npnpm a \\\n```\n```bash\ntsx b\n```\n```bash\npnpm c \\').map((c) => [c.line, c.words]),
      [
        [2, ['pnpm', 'a', '\\']],
        [5, ['tsx', 'b']],
        [8, ['pnpm', 'c', '\\']],
      ],
    );
  });

  it('takes a lone script path in an untyped fence as a mention', () => {
    assert.deepEqual(commandsOf('```\nscripts/x.ts --a\n```\n'), []);
  });

  it('reads the exempt marker the config names', () => {
    const content = '```bash\npnpm a # skip-me\n```\nRun `pnpm b` (skip-me).\n';
    assert.deepEqual(
      commandsOf(content).map((c) => c.line),
      [2, 4],
    );
    assert.deepEqual(documentedCommands('x.md', content, /skip-me/), []);
  });
});
