import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findCommandProblems } from './doc-command-rules.ts';
import type { Config } from './doc-references-config.ts';
import { CONFIG, testConfig } from './doc-references.fixture.test.ts';
import { scriptBodies, type ScriptProblem } from './doc-scripts.ts';

// ---------------------------------------------------------------------------
// DOC-DRIFT-02: the command as written runs
// ---------------------------------------------------------------------------

const MANIFEST = JSON.stringify({
  name: 'root',
  scripts: {
    gate: 'tsx scripts/gate.ts',
    tool: 'python3 scripts/tool.py',
    'test:db': 'tsx scripts/test-db.ts vitest run',
    'lint:ci': 'eslint .',
    wrapped: 'FOO=1 pnpm exec tsx scripts/gate.ts',
  },
});
const SERVER_MANIFEST = JSON.stringify({
  name: '@acme/server',
  scripts: { 'validate:prds': 'tsx scripts/validate-prds.ts' },
});
const GATE_SOURCE = ["import { parseArgs } from 'node:util';", '// usage: gate.ts [--staged] [--mode <fast|full>]', 'parseArgs({ options: { staged: { type: "boolean" }, mode: { type: "string" } } });', ''].join('\n');
const TOOL_SOURCE = ['import argparse', 'p = argparse.ArgumentParser()', 'p.add_argument("action", choices=["plan", "apply"])', 'p.add_argument("--out", required=True)', 'p.add_argument("--level", choices=["low", "high"])', ''].join('\n');

const XML = '.agent/skills/sync/run-quality-checks.xml';

/** The DOC-DRIFT-02 command problems of `doc` in a small in-memory repo. */
const commands = (doc: string, extra: Record<string, string> = {}, config: Config = CONFIG, docs: readonly string[] = [XML]): ScriptProblem[] => {
  const files = new Map(
    Object.entries({
      'package.json': MANIFEST,
      'apps/server/package.json': SERVER_MANIFEST,
      'apps/server/scripts/validate-prds.ts': 'export {};\n',
      'scripts/gate.ts': GATE_SOURCE,
      'scripts/tool.py': TOOL_SOURCE,
      'scripts/test-db.ts': 'export {};\n',
      'scripts/run.sh': '#!/bin/sh\nexec node x.js "$@"\n',
      ...extra,
      [XML]: doc,
    }),
  );
  const read = (path: string): string | undefined => files.get(path);
  return findCommandProblems(config, { read, exists: (path) => files.has(path), ...scriptBodies(config.scripts.manifests, read) }, docs);
};

const fence = (...lines: string[]): string => ['<step>', '```bash', ...lines, '```', '</step>', ''].join('\n');

describe('DOC-DRIFT-02: a corrected command', () => {
  it('passes the corrected command', () => {
    assert.deepEqual(commands(fence('pnpm --filter @acme/server validate:prds')), []);
  });
});

describe('quoted operators', () => {
  // A package script whose body quoted a `;` read as two commands, so the
  // doc's flags went unchecked.
  it("reads a package script's quoted `;` as one command", () => {
    const manifest = JSON.stringify({
      name: 'root',
      scripts: {
        quoted: "tsx scripts/gate.ts --mode 'a;b'",
        listed: 'tsx scripts/gate.ts; echo done',
      },
    });
    const found = commands(fence('pnpm quoted --nope', 'pnpm listed --nope'), { 'package.json': manifest });
    assert.deepEqual(
      found.map((p) => [p.line, p.script]),
      [[3, '--nope']],
    );
  });
});

describe('DOC-DRIFT-02 command rules', () => {
  it('flags --filter written after a script that reads its own flags', () => {
    const found = commands(fence('pnpm gate --filter @acme/server'));
    assert.equal(found.length, 1);
    assert.match(found[0]?.reason ?? '', /handed to the script/);
  });

  it('near-miss: turbo and nested commands own their --filter', () => {
    assert.deepEqual(commands(fence('pnpm turbo run test --filter @acme/server', 'pnpm test:db pnpm --filter @acme/server test')), []);
  });

  it('flags a flag the script never reads, and a bad enum value', () => {
    const found = commands(fence('pnpm gate --staged --since main', 'pnpm gate --mode slow'));
    assert.deepEqual(
      found.map((p) => p.script),
      ['--since', '--mode'],
    );
    assert.match(found[1]?.reason ?? '', /accepts fast, full/);
  });

  // A word read to `\S+` kept the quotes of `--mode="slow"` (so the enum
  // check skipped it) and split `--mode="fast --since b"` at its spaces (so
  // `--since` read as a flag).
  it('reads a quoted flag value as the one word bash passes', () => {
    const found = commands(fence('pnpm gate --mode="slow"', 'pnpm gate --mode="fast --since b"'));
    assert.deepEqual(
      found.map((p) => [p.line, p.script]),
      [[3, '--mode']],
    );
    assert.match(found[0]?.reason ?? '', /`--mode slow`/);
  });

  // bash hands the script `--since`, not `$\x2d…`.
  it('reads an ANSI-C quoted flag as the word bash passes', () => {
    const found = commands(fence("pnpm gate $'\\x2d\\x2dsince' main"));
    assert.deepEqual(
      found.map((p) => [p.line, p.script]),
      [[3, '--since']],
    );
  });

  it('flags a missing required flag and an unknown action (argparse)', () => {
    const found = commands(fence('python3 scripts/tool.py plan', 'python3 scripts/tool.py destroy --out o --level mid'));
    assert.deepEqual(
      found.map((p) => [p.line, p.script]),
      [
        [3, '--out'],
        [4, '--level'],
        [4, 'destroy'],
      ],
    );
  });

  // Only the first word was read as the action, so an action after an
  // option went unchecked.
  it('finds the action after options and their values (argparse)', () => {
    assert.deepEqual(
      commands(
        fence(
          'python3 scripts/tool.py --out result destroy',
          'python3 scripts/tool.py --out=result destroy',
          'python3 scripts/tool.py --out destroy plan',
          'python3 scripts/tool.py -q destroy --out o',
          'python3 scripts/tool.py --out o --level high',
          'python3 scripts/tool.py --out --pair a b destroy',
          'python3 scripts/tool.py --pair a b plan --out o',
          'python3 scripts/tool.py --pair a --out o destroy',
        ),
        { 'scripts/tool.py': `${TOOL_SOURCE}p.add_argument("--pair", nargs=2)\n` },
      ).map((p) => [p.line, p.reason]),
      [
        [3, '`destroy` is not an action of `scripts/tool.py` (plan, apply)'],
        [4, '`destroy` is not an action of `scripts/tool.py` (plan, apply)'],
        [6, '`destroy` is not an action of `scripts/tool.py` (plan, apply)'],
        // `nargs=2` takes two words, and values end at the next option.
        [8, '`destroy` is not an action of `scripts/tool.py` (plan, apply)'],
        [10, '`destroy` is not an action of `scripts/tool.py` (plan, apply)'],
      ],
    );
  });

  // A script an `npx -c` call runs went unjudged.
  it('judges the commands an npx --call runs', () => {
    assert.deepEqual(
      commands(fence("npx -c 'echo ok; tsx scripts/gate.ts --bogus'", 'npx --call= tsx scripts/gate.ts --bogus')).map((p) => [p.line, p.script]),
      [
        [3, '--bogus'],
        // An empty call is none: npm runs the words after it.
        [4, '--bogus'],
      ],
    );
  });

  it('does not require flags of a program merely named inline', () => {
    assert.deepEqual(commands('Run `python3 scripts/tool.py` to see help.\n'), []);
  });

  it('flags TypeScript started by node or as a program', () => {
    const found = commands(fence('node scripts/gate.ts', 'scripts/gate.ts --staged'));
    assert.equal(found.length, 2);
    assert.match(found[0]?.reason ?? '', /does not run TypeScript/);
    assert.match(found[1]?.reason ?? '', /run as a program/);
  });

  it('accepts node with a TypeScript loader, and a forwarding shell script', () => {
    assert.deepEqual(commands(fence('node --import tsx scripts/gate.ts --staged', 'bash scripts/run.sh --anything', 'pnpm exec tsx scripts/gate.ts --mode fast')), []);
  });
});

describe('DOC-DRIFT-02 resolving the script a command runs', () => {
  const reasons = (lines: string[], extra: Record<string, string> = {}, config: Config = CONFIG): Array<[number, string]> => commands(fence(...lines), extra, config).map((p) => [p.line, p.reason]);
  const notAFlag = (path: string, flag = '--bogus'): string => `\`${flag}\` is not a flag of \`${path}\` — the script never reads it`;

  it('follows npx, pnpm exec, wrapped scripts and node loaders to the script', () => {
    assert.deepEqual(reasons(['npx tsx scripts/gate.ts --bogus', 'pnpm exec tsx scripts/gate.ts --bogus', 'pnpm wrapped --bogus', 'node --import tsx scripts/gate.ts --bogus', 'pnpm exec tsx --version', 'pnpm lint:ci', 'tsx scripts/gate.ts --staged', 'pnpm gate -- --bogus']), [
      [3, notAFlag('scripts/gate.ts')],
      [4, notAFlag('scripts/gate.ts')],
      [5, notAFlag('scripts/gate.ts')],
      [6, notAFlag('scripts/gate.ts')],
      [10, notAFlag('scripts/gate.ts')],
    ]);
  });

  for (const interpreter of ['bash', 'sh', 'python', 'python3']) {
    it(`flags TypeScript started by ${interpreter}`, () => {
      assert.deepEqual(reasons([`${interpreter} scripts/gate.ts`]), [[3, `\`${interpreter} scripts/gate.ts\` does not run TypeScript here — use \`pnpm exec tsx scripts/gate.ts\``]]);
    });
  }

  // One fence each: a fence's `cd` carries to its later lines.
  it('resolves from the cd or -C directory first, then the root', () => {
    assert.deepEqual(
      [
        'pnpm -C apps/server exec tsx scripts/validate-prds.ts --bogus',
        'cd apps/server && pnpm exec tsx scripts/validate-prds.ts --bogus',
        'cd apps/server && pnpm exec tsx scripts/gate.ts --bogus',
        'cd apps/server && pnpm tsx scripts/validate-prds.ts --bogus',
        'cd apps/server && pnpm tsx scripts/gate.ts --bogus',
        'cd apps/server && tsx scripts/validate-prds.ts --bogus',
        'cd apps/server && tsx scripts/gate.ts --bogus',
      ].flatMap((line) => reasons([line])),
      [
        [3, notAFlag('apps/server/scripts/validate-prds.ts')],
        [3, notAFlag('apps/server/scripts/validate-prds.ts')],
        [3, notAFlag('scripts/gate.ts')],
        [3, notAFlag('apps/server/scripts/validate-prds.ts')],
        [3, notAFlag('scripts/gate.ts')],
        [3, notAFlag('apps/server/scripts/validate-prds.ts')],
        [3, notAFlag('scripts/gate.ts')],
      ],
    );
  });

  // `cd apps/mobile` on its own line, then a path from there, was resolved from the root.
  it('resolves a later fence line from a cd on an earlier one', () => {
    assert.deepEqual(reasons(['cd apps/server', 'tsx scripts/validate-prds.ts --bogus']), [[4, notAFlag('apps/server/scripts/validate-prds.ts')]]);
  });

  // Every `--import` or `--loader` word stood the rule down, and the module
  // after `--import` was read as the script, so `node --import x s.ts` passed.
  for (const command of [
    'node --import some-module scripts/gate.ts',
    'node --import=other scripts/gate.ts',
    'node --loader ./x.mjs scripts/gate.ts',
    'node --require dotenv/config scripts/gate.ts',
    'node --import tsxfoo scripts/gate.ts',
    'node --import xtsx scripts/gate.ts',
    'node --env-file tsx scripts/gate.ts',
    'node --env-file=.env scripts/gate.ts',
    'node --env-file .env scripts/gate.ts',
    'node --watch scripts/gate.ts',
    'node scripts/gate.ts --import tsx',
    'node -r dotenv/config scripts/gate.ts',
    'node --title report scripts/gate.ts',
    'bash -r scripts/gate.ts',
    'sh --experimental-strip-types scripts/gate.ts',
    // Only node reads a stripping flag or a loader.
    'bash --experimental-strip-types scripts/gate.ts',
    'python3 --experimental-strip-types scripts/gate.ts',
    'node -- scripts/gate.ts',
  ]) {
    it(`refuses \`${command}\`: nothing before the script loads TypeScript`, () => {
      const [interpreter] = command.split(' ');
      assert.deepEqual(reasons([command]), [[3, `\`${String(interpreter)} scripts/gate.ts\` does not run TypeScript here — use \`pnpm exec tsx scripts/gate.ts\``]]);
    });
  }

  for (const command of [
    'node --import tsx scripts/gate.ts',
    'node --import=tsx scripts/gate.ts',
    'node --import tsx/esm scripts/gate.ts',
    'node --loader tsx scripts/gate.ts',
    'node --loader=tsx/esm scripts/gate.ts',
    'node --require tsx/cjs scripts/gate.ts',
    'node -r tsx/cjs scripts/gate.ts',
    'node --experimental-loader tsx scripts/gate.ts',
    'node --experimental-strip-types scripts/gate.ts',
    'node --experimental-transform-types scripts/gate.ts',
    'node --watch --import tsx scripts/gate.ts',
    'node --import tsx -- scripts/gate.ts',
  ]) {
    it(`accepts \`${command}\`: a tsx loader or type stripping`, () => {
      assert.deepEqual(reasons([command]), []);
    });
  }

  for (const command of [
    'node --version',
    'node scripts/x.tsx',
    'node scripts/x.js',
    'eslint scripts/gate.ts',
    // After `--`, node runs a file named `--import`; the `.ts` is its argument.
    'node -- --import tsx scripts/gate.ts',
  ]) {
    it(`leaves \`${command}\` alone: no \`.ts\` program started`, () => {
      assert.deepEqual(reasons([command]), []);
    });
  }

  it('a --filter after `--` is the script’s, not misplaced', () => {
    assert.deepEqual(reasons(['pnpm gate -- --filter x']), [[3, notAFlag('scripts/gate.ts', '--filter')]]);
  });

  it('requires flags of a fenced or argument-bearing command, unless asking for help', () => {
    assert.deepEqual(reasons(['python3 scripts/tool.py', 'python3 scripts/tool.py --help', 'python3 scripts/tool.py plan --out=o', 'python3 scripts/tool.py nope --out o']), [
      [3, '`scripts/tool.py` requires `--out`; the documented command omits it'],
      [6, '`nope` is not an action of `scripts/tool.py` (plan, apply)'],
    ]);
  });

  it('reads the flags of the modules a script imports, and only a module’s', () => {
    const modules = {
      'scripts/mod.ts': ["import './side';", "import { a } from './a';", "import { b } from './b';", "import { c } from './c';", "import { d } from './d.js';", "import { e } from './e.ts';", 'z'].join('\n'),
      'scripts/a.ts': 'a // --a1',
      'scripts/b.mjs': 'b // --b1',
      'scripts/c.js': 'c // --c1',
      'scripts/d.ts': 'd // --d1',
      'scripts/e.ts': 'e // --e1',
      'scripts/plain.sh': "echo --known\n# from './e.ts'\n",
    };
    assert.deepEqual(reasons(['pnpm exec tsx scripts/mod.ts --a1 --b1 --c1 --d1 --e1', 'bash scripts/plain.sh --known --e1'], modules), [[4, notAFlag('scripts/plain.sh', '--e1')]]);
  });

  it('reads a script that exists but cannot be read as an empty one', () => {
    const doc = fence('tsx scripts/gone.ts --bogus');
    const read = (path: string): string | undefined => (path === XML ? doc : undefined);
    assert.deepEqual(findCommandProblems(CONFIG, { read, exists: (path) => path === 'scripts/gone.ts', ...scriptBodies(CONFIG.scripts.manifests, read) }, [XML]), [{ file: XML, line: 3, script: '--bogus', reason: '`--bogus` is not a flag of `scripts/gone.ts` — the script never reads it' }]);
  });

  it('skips a listed file it cannot read', () => {
    assert.deepEqual(commands(fence('node scripts/gate.ts'), {}, CONFIG, ['docs/missing.md']), []);
  });

  it('runs a script the cd scope or the filter names, and a bin as a script name', () => {
    assert.deepEqual(reasons(['cd apps/server && pnpm validate:prds --bogus', 'pnpm --filter @acme/server validate:prds --bogus', 'pnpm --filter nobody validate:prds --bogus', 'pnpm tsx scripts/gate.ts --bogus', 'pnpm nothing --bogus']), [
      [3, notAFlag('apps/server/scripts/validate-prds.ts')],
      [4, notAFlag('apps/server/scripts/validate-prds.ts')],
      [6, notAFlag('scripts/gate.ts')],
    ]);
  });

  it('passes an enum value it cannot judge, and one the script accepts', () => {
    assert.deepEqual(reasons(['pnpm gate --mode', 'pnpm gate --mode --staged', 'pnpm gate --mode "a b"', 'pnpm gate --mode=full']), []);
  });

  it('judges no flags of a script that forwards its arguments', () => {
    assert.deepEqual(reasons(['bash scripts/run.sh --anything --else']), []);
  });
});

describe('the config’s TypeScript runner', () => {
  const OFF = testConfig({ commands: { typescriptRunner: null } });

  // With no runner the `.ts` launch rules are off; the flag rules still run.
  it('leaves a `.ts` launch unjudged when the runner is null', () => {
    assert.deepEqual(commands(fence('node scripts/gate.ts --bogus', 'scripts/gate.ts --staged', 'bash scripts/gate.ts')), [
      { file: XML, line: 3, script: 'scripts/gate.ts', reason: '`node scripts/gate.ts` does not run TypeScript here — use `pnpm exec tsx scripts/gate.ts`' },
      { file: XML, line: 4, script: 'scripts/gate.ts', reason: '`scripts/gate.ts` is TypeScript run as a program — start it with `pnpm exec tsx scripts/gate.ts`' },
      { file: XML, line: 5, script: 'scripts/gate.ts', reason: '`bash scripts/gate.ts` does not run TypeScript here — use `pnpm exec tsx scripts/gate.ts`' },
    ]);
    assert.deepEqual(commands(fence('node scripts/gate.ts --bogus', 'scripts/gate.ts --staged', 'bash scripts/gate.ts'), {}, OFF), [{ file: XML, line: 3, script: '--bogus', reason: '`--bogus` is not a flag of `scripts/gate.ts` — the script never reads it' }]);
  });

  it('names a custom runner in the reason', () => {
    const bun = testConfig({ commands: { typescriptRunner: 'bun run' } });
    assert.deepEqual(
      commands(fence('node scripts/gate.ts', 'scripts/gate.ts --staged'), {}, bun).map((p) => p.reason),
      ['`node scripts/gate.ts` does not run TypeScript here — use `bun run scripts/gate.ts`', '`scripts/gate.ts` is TypeScript run as a program — start it with `bun run scripts/gate.ts`'],
    );
  });
});

describe('the config’s nested commands', () => {
  it('reads a wrapper script by the nested commands the config lists', () => {
    // `test:db` runs vitest: with vitest nested the doc's words are vitest's, unjudged.
    assert.deepEqual(commands(fence('pnpm test:db --coverage')), []);
    // With nothing nested, test:db reads its own arguments and never declares `--coverage`.
    assert.deepEqual(
      commands(fence('pnpm test:db --coverage'), {}, testConfig({ commands: { nested: [] } })).map((p) => [p.line, p.reason]),
      [[3, '`--coverage` is not a flag of `scripts/test-db.ts` — the script never reads it']],
    );
  });

  it('stops judging flags at a nested command the config adds', () => {
    assert.deepEqual(
      commands(fence('pnpm exec tsx scripts/gate.ts bun --bogus')).map((p) => p.script),
      ['--bogus'],
    );
    assert.deepEqual(commands(fence('pnpm exec tsx scripts/gate.ts bun --bogus'), {}, testConfig({ commands: { nested: ['bun'] } })), []);
  });
});
