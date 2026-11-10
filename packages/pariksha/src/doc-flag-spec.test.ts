import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flagSpec } from './doc-flag-spec.ts';

const GATE_SOURCE = ["import { parseArgs } from 'node:util';", '// usage: gate.ts [--staged] [--mode <fast|full>]', 'parseArgs({ options: { staged: { type: "boolean" }, mode: { type: "string" } } });', ''].join('\n');
const TOOL_SOURCE = ['import argparse', 'p = argparse.ArgumentParser()', 'p.add_argument("action", choices=["plan", "apply"])', 'p.add_argument("--out", required=True)', 'p.add_argument("--level", choices=["low", "high"])', ''].join('\n');

describe('flagSpec', () => {
  it('reads flag declarations from source', () => {
    const spec = flagSpec(GATE_SOURCE, 'scripts/gate.ts');
    assert.equal(spec.closed, true);
    assert.equal(spec.known('--staged'), true);
    assert.equal(spec.known('--help'), true);
    assert.equal(spec.known('--nope'), false);
    assert.deepEqual([...(spec.values('--mode') ?? [])], ['fast', 'full']);
    assert.equal(flagSpec('x "$@"', 'run.sh').closed, false);
    assert.equal(flagSpec('{a,b}', 'x.ts').values('--z'), undefined);
    assert.deepEqual([...(flagSpec('--k {a,b}', 'x.ts').values('--k') ?? [])], ['a', 'b']);
    const python = flagSpec(TOOL_SOURCE, 'tool.py');
    assert.deepEqual(python.required, ['--out']);
    assert.deepEqual([...(python.positional ?? [])], ['plan', 'apply']);
    assert.deepEqual(flagSpec(`${TOOL_SOURCE}p.add_subparsers()\n`, 'tool.py').required, ['--out']);
  });

  // Every required flag was dropped once a script had subparsers, and a
  // later positional's choices were read as the first's.
  describe('subcommands and positionals (argparse)', () => {
    const SUBCOMMANDS = [
      'p = argparse.ArgumentParser()',
      'p.add_argument("--root", required=True)',
      'subs = p.add_subparsers(dest="cmd")',
      'run = subs.add_parser("run")',
      'run.add_argument("--target", required=True)',
      'run.add_argument("where", choices=["here"])',
      'deep = self.subs.add_parser("deep")',
      'deep.add_argument("--depth", required=True)',
      'subs.add_parser("x").add_argument("--chained", required=True)',
      '',
    ].join('\n');

    it('keeps the root parser’s required flags, not a subcommand’s', () => {
      const spec = flagSpec(SUBCOMMANDS, 'x.py');
      assert.deepEqual(spec.required, ['--root']);
      assert.equal(spec.positional, undefined);
    });

    it('keeps a chained call’s required flag when there are no subparsers', () => {
      assert.deepEqual(flagSpec('argparse.ArgumentParser().add_argument("--z", required=True)', 'x.py').required, ['--z']);
    });

    const requiredCases: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['p.add_argument("--a", required=True)', ['--a']],
      ['p.add_argument(\n  "--a",\n  required = True)', ['--a']],
      ["p.add_argument('--a', required=True)", ['--a']],
      ['p.add_argument("--a", help="x")', []],
      ['p.add_argument("--a", required=False)', []],
      ['p.add_argument("-a", required=True)', []],
    ];
    for (const [source, required] of requiredCases) {
      it(`reads required flags: ${source}`, () => {
        assert.deepEqual(flagSpec(source, 'x.py').required, required);
      });
    }

    // How many words an option takes, so the first positional after options is found.
    const countCases: ReadonlyArray<readonly [string, string, number]> = [
      ['p.add_argument("--o")', '--o', 1],
      ['p.add_argument("--o", type=int)', '--o', 1],
      ['p.add_argument("--o", action="append")', '--o', 1],
      ['p.add_argument("--o", nargs="?")', '--o', 1],
      ['p.add_argument("--o", nargs=2)', '--o', 2],
      ['p.add_argument("--o", nargs = 12 , type=int)', '--o', 12],
      ['p.add_argument("--o", nargs="+")', '--o', Infinity],
      ["p.add_argument('--o', nargs='*')", '--o', Infinity],
      ['p.add_argument("--o", nargs=argparse.REMAINDER)', '--o', Infinity],
      ['p.add_argument("--o", nargs=N2)', '--o', Infinity],
      ['p.add_argument("--o", nargs=2x)', '--o', Infinity],
      ['p.add_argument("-o", "--out")', '-o', 1],
      ["p.add_argument('-o' , '--out', type=str)", '--out', 1],
      ['p.add_argument("-o", help="--x")', '--x', 0],
      ['p.add_argument("--o")', '--p', 0],
      ['p.add_argument("--o", action="store_true")', '--o', 0],
      ["p.add_argument('--o', action = 'store_false')", '--o', 0],
      ['p.add_argument("--o", action="store_const", const=1)', '--o', 0],
      ['p.add_argument("--o", action="append_const", const=1)', '--o', 0],
      ['p.add_argument("--o", action="count")', '--o', 0],
      ['p.add_argument("--o", action="help")', '--o', 0],
      ['p.add_argument("--o", action="version")', '--o', 0],
      ['p.add_argument("--o", action="countx")', '--o', 1],
      ['p.add_argument("--o", action=argparse.BooleanOptionalAction)', '--o', 0],
      ['p.add_argument("--o", action=BooleanOptionalAction)', '--o', 0],
      ['p.add_argument("--o", action=BooleanOptionalActionX)', '--o', 1],
      ['p.add_argument("--o", nargs=0)', '--o', 0],
      // A string is one argument, whatever it spells.
      ['p.add_argument("--o", help="nargs=0")', '--o', 1],
      ["p.add_argument('--o', help='action=\"count\"')", '--o', 1],
      ['p.add_argument("--o", "nargs=0")', '--o', 1],
      ["p.add_argument('--o', 'nargs=0')", '--o', 1],
      ['subs = p.add_subparsers()\nr = subs.add_parser("r")\nr.add_argument("--o")', '--o', 0],
    ];
    for (const [source, flag, count] of countCases) {
      it(`reads how many words an option takes: ${source} ${flag}`, () => {
        assert.equal(flagSpec(source, 'x.py').valueCount(flag), count);
        assert.equal(flagSpec(source, 'x.ts').valueCount(flag), 0);
      });
    }

    const positionalCases: ReadonlyArray<readonly [string, readonly string[] | null]> = [
      ['p.add_argument("path")\np.add_argument("mode", choices=["a"])', null],
      ['p.add_argument("-v")\np.add_argument("mode", choices=["a"])', ['a']],
      ['p.add_argument("Mode", choices = ("a", "b"))', ['a', 'b']],
      ['p.add_argument("mode", help="x")', null],
    ];
    for (const [source, choices] of positionalCases) {
      it(`reads the first positional’s choices: ${source}`, () => {
        const positional = flagSpec(source, 'x.py').positional;
        assert.deepEqual(positional === undefined ? null : [...positional], choices);
      });
    }
  });

  it('reads which scripts are closed, and how flags are declared', () => {
    assert.equal(flagSpec('x "$@"', 'bin/run').closed, false);
    assert.equal(flagSpec('x', 'bin/run').closed, true);
    // A sourced file runs with the script's arguments (`--staged` through a
    // shared helper); a word ending in `source` sources nothing.
    assert.equal(flagSpec('M="$1"\nsource "$d/h.sh"', 'x.sh').closed, false);
    assert.equal(flagSpec('set -e\n  . ./h.sh', 'x.sh').closed, false);
    assert.equal(flagSpec('x\nresource y\nx.y z', 'x.sh').closed, true);
    assert.equal(flagSpec('source "$d/h.sh"', 'x.ts').closed, true);
    assert.deepEqual(flagSpec('p.add_argument("--out", required=True)', 'x.ts').required, []);
    assert.equal(flagSpec('import sys\n', 'x.py').closed, true);
    assert.equal(flagSpec('parse_known_args()\n', 'x.py').closed, false);
    assert.equal(flagSpec('parse_known_args()\np.add_argument("--a")\n', 'x.py').closed, true);
    assert.equal(flagSpec('', 'x.ts').known('-h'), true);
    assert.equal(flagSpec('parseArgs({ options: { verbose: { type: "boolean" } } })', 'x.ts').known('--verbose'), true);
    assert.deepEqual([...(flagSpec('p.add_argument(\n  "--level",\n  choices=["a", "b"])', 'x.py').values('--level') ?? [])], ['a', 'b']);
  });

  it('reads the forwarding forms of each language', () => {
    for (const source of ['x $*', 'x "${@}"', 'x $@']) assert.equal(flagSpec(source, 'x.bash').closed, false, source);
    assert.equal(flagSpec('main(sys.argv[1:])', 'x.py').closed, false);
    assert.equal(flagSpec('parseArgs({ strict: false })', 'x.ts').closed, false);
    assert.equal(flagSpec('parseArgs({ strict: true })', 'x.ts').closed, true);
  });

  it('declares no positional for a script that is not Python', () => {
    assert.equal(flagSpec(TOOL_SOURCE, 'tool.ts').positional, undefined);
    assert.deepEqual(flagSpec(TOOL_SOURCE, 'tool.ts').required, []);
  });

  it('reads an enum from the usage text with `=`, and refuses a single value', () => {
    assert.deepEqual([...(flagSpec('usage: --mode=<a|b>', 'x.ts').values('--mode') ?? [])], ['a', 'b']);
    assert.deepEqual([...(flagSpec('--k={a,b,c}', 'x.ts').values('--k') ?? [])], ['a', 'b', 'c']);
    assert.equal(flagSpec('--mode <a>', 'x.ts').values('--mode'), undefined);
    assert.equal(flagSpec('--k {a}', 'x.ts').values('--k'), undefined);
  });

  it('knows a flag only as a whole word', () => {
    assert.equal(flagSpec('--stage', 'x.ts').known('--stage'), true);
    assert.equal(flagSpec('--staged', 'x.ts').known('--stage'), false);
    assert.equal(flagSpec("{ 'dry-run': { type: 'boolean' } }", 'x.ts').known('--dry-run'), true);
    assert.equal(flagSpec('{ dry: { short: "d" } }', 'x.ts').known('--dry'), false);
  });
});
