// license-check, ported case for case from the script it replaces; the cases
// that read that repository's own allow list read a neutral one here.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { execFile, type Exec, fromPnpm, isAllowed, judge, type LicenseConfig, packageName, parseLicenseConfig, pnpmLicenses, runLicenseCheck, violations } from './license-check.ts';

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'license-check-'));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const binary = 'a platform binary of build-tool, same licence';
/** A repository's settings: permissive licences, a build tool allowed by name, two packages by version. */
const CONFIG: LicenseConfig = {
  allow: ['0BSD', 'Apache 2.0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MIT', 'MIT-0', 'Public Domain', 'UNLICENSED'],
  packages: {
    'build-tool': 'source-available build tool: its licence permits this use',
    'build-tool-darwin': binary,
    'build-tool-linux-x64': binary,
    'no-licence-pkg@1.0.13': 'declares no licence; its readme carries the MIT licence',
    'custom-dict@2.1.10': 'custom licence, read and accepted',
    'old-pkg@0.0.1': 'declares no licence; its LICENSE file is MIT',
    'legacy-stream@1.0.4': 'declares "bsd"; its LICENSE file is BSD-2-Clause',
  },
};
const ONLY = (allow: string[], packages: Record<string, string> = {}): LicenseConfig => ({ allow, packages });

describe('packageName', () => {
  it('drops the version from plain and scoped ids', () => {
    assert.equal(packageName('left-pad@1.3.0'), 'left-pad');
    assert.equal(packageName('@scope/cli@2.58.6'), '@scope/cli');
  });

  it('keeps an id with no version whole', () => {
    assert.equal(packageName('left-pad'), 'left-pad');
    assert.equal(packageName('@scope/name'), '@scope/name');
  });
});

describe('isAllowed', () => {
  const allowed = ['MIT', 'ISC', 'BSD-3-Clause', 'Apache-2.0'];

  it('accepts a licence equal to an allowed name', () => {
    assert.equal(isAllowed('MIT', allowed), true);
    assert.equal(isAllowed(' ISC ', allowed), true);
  });

  it('refuses a licence that only contains an allowed name', () => {
    assert.equal(isAllowed('FSL-1.1-MIT', allowed), false);
    assert.equal(isAllowed('MIT-0', allowed), false);
    assert.equal(isAllowed('GPL-2.0', allowed), false);
  });

  it('accepts an OR expression when one branch is allowed', () => {
    assert.equal(isAllowed('(BSD-3-Clause OR GPL-2.0)', allowed), true);
    assert.equal(isAllowed('GPL-3.0 OR ISC', allowed), true);
    assert.equal(isAllowed('(GPL-2.0 OR AGPL-3.0)', allowed), false);
  });

  it('accepts an AND expression only when every term is allowed', () => {
    assert.equal(isAllowed('(MIT AND BSD-3-Clause)', allowed), true);
    assert.equal(isAllowed('Apache-2.0 AND MIT', allowed), true);
    assert.equal(isAllowed('MIT AND GPL-2.0', allowed), false);
  });

  it('reads a branch with its own parentheses', () => {
    assert.equal(isAllowed('(GPL-2.0 OR (MIT AND ISC))', allowed), true);
    assert.equal(isAllowed('(GPL-2.0 OR (MIT AND LGPL-3.0))', allowed), false);
  });

  it('binds AND tighter than OR and honours grouping', () => {
    assert.equal(isAllowed('GPL-2.0 OR MIT AND ISC', allowed), true);
    assert.equal(isAllowed('MIT OR ISC AND GPL-2.0', allowed), true);
    assert.equal(isAllowed('(MIT OR ISC) AND GPL-2.0', allowed), false);
    assert.equal(isAllowed('(MIT OR GPL-2.0) AND ISC', allowed), true);
  });

  it('reads a licence name that holds spaces', () => {
    assert.equal(isAllowed('Apache 2.0 OR GPL-2.0', ['Apache 2.0']), true);
    assert.equal(isAllowed('Public Domain', ['Public Domain']), true);
    assert.equal(isAllowed('Apache 2.0 Extra', ['Apache 2.0']), false);
  });

  it('refuses a malformed expression', () => {
    for (const expression of ['', '(MIT', 'MIT AND', 'OR MIT', '(MIT))', '()', 'MIT ) ISC', 'MIT) OR ISC', '(MIT (']) {
      assert.equal(isAllowed(expression, allowed), false, expression);
    }
  });

  it('never reads a bracket as part of a licence name', () => {
    assert.equal(isAllowed('MIT ( OR ISC', ['MIT (', 'ISC']), false);
  });
});

describe('parseLicenseConfig', () => {
  it('reads the allow list and the packages allowed by name, each with its reason', () => {
    assert.deepEqual(parseLicenseConfig(JSON.stringify(CONFIG)), CONFIG);
  });

  it('reads no packages as none allowed by name', () => {
    assert.deepEqual(parseLicenseConfig('{"allow": ["MIT"]}'), { allow: ['MIT'], packages: {} });
  });

  for (const [label, text, message] of [
    ['text that is not JSON', '{', /^Error: not JSON: /],
    ['a list', '[]', /must be a JSON object/],
    ['an unknown key', '{"allow": ["MIT"], "allowed": []}', /unknown key "allowed"; license-check reads allow, packages/],
    ['no allow list', '{}', /"allow" must be a non-empty list of licence names/],
    ['an empty allow list', '{"allow": []}', /"allow" must be a non-empty list/],
    ['a blank licence name', '{"allow": ["MIT", " "]}', /"allow" must be a non-empty list/],
    ['a licence name that is not text', '{"allow": ["MIT", 1]}', /"allow" must be a non-empty list/],
    ['packages that are a list', '{"allow": ["MIT"], "packages": ["a"]}', /"packages" must be an object/],
    ['a package with no reason', '{"allow": ["MIT"], "packages": {"a": ""}}', /"packages": "a" must be a package name with a reason/],
    ['a reason that is not text', '{"allow": ["MIT"], "packages": {"a": true}}', /"packages": "a" must be/],
    ['a package with no name', '{"allow": ["MIT"], "packages": {"": "why"}}', /"packages": "" must be/],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.throws(() => parseLicenseConfig(text), message);
    });
  }
});

describe('violations', () => {
  it('lists each package whose licence is not allowed, with that licence', () => {
    assert.deepEqual(violations({ 'a@1.0.0': { licenses: 'MIT' }, 'b@1.0.0': { licenses: 'FSL-1.1-MIT' }, 'c@2.0.0': { licenses: 'SSPL-1.0' } }, CONFIG), [
      { pkg: 'b@1.0.0', license: 'FSL-1.1-MIT' },
      { pkg: 'c@2.0.0', license: 'SSPL-1.0' },
    ]);
  });

  it('accepts a package that lists several licences when one is allowed', () => {
    assert.deepEqual(violations({ 'a@1.0.0': { licenses: ['GPL-2.0', 'MIT'] }, 'b@1.0.0': { licenses: ['GPL-2.0', 'AGPL-3.0'] } }, CONFIG), [{ pkg: 'b@1.0.0', license: 'GPL-2.0, AGPL-3.0' }]);
  });

  it('reads a package with no licence as UNKNOWN, which is not allowed', () => {
    assert.deepEqual(violations({ 'a@1.0.0': {} }, CONFIG), [{ pkg: 'a@1.0.0', license: 'UNKNOWN' }]);
  });

  it('skips a package allowed by name at any version, or by name@version at that version only', () => {
    const packages = { tool: 'by name', 'pinned@1.0.0': 'by version' };
    assert.deepEqual(
      violations(
        {
          'tool@1.0.0': { licenses: 'FSL-1.1-MIT' },
          'tool@9.9.9': { licenses: 'FSL-1.1-MIT' },
          'pinned@1.0.0': { licenses: 'UNKNOWN' },
          'pinned@1.0.1': { licenses: 'UNKNOWN' },
        },
        ONLY(['MIT'], packages),
      ),
      [{ pkg: 'pinned@1.0.1', license: 'UNKNOWN' }],
    );
  });

  it('allows a tool and its platform binaries by name, and two packages at their versions', () => {
    assert.deepEqual(
      violations(
        {
          'build-tool@3.7.0': { licenses: 'FSL-1.1-MIT' },
          'build-tool-darwin@2.58.6': { licenses: 'FSL-1.1-MIT' },
          'build-tool-linux-x64@3.7.0': { licenses: 'FSL-1.1-MIT' },
          'no-licence-pkg@1.0.13': { licenses: 'UNKNOWN' },
          'custom-dict@2.1.10': { licenses: 'Custom: https://example.com/licence' },
        },
        CONFIG,
      ),
      [],
    );
  });

  it('allows the listed licences exactly and nothing that only contains one', () => {
    for (const license of ['MIT', 'MIT-0', 'Apache 2.0', 'Public Domain', 'UNLICENSED']) assert.equal(isAllowed(license, CONFIG.allow), true, license);
    assert.equal(isAllowed('FSL-1.1-MIT', CONFIG.allow), false);
    assert.equal(isAllowed('BSD-4-Clause', CONFIG.allow), false);
    // A licence-file guess some checkers report; pnpm never reports one.
    assert.equal(isAllowed('MIT*', CONFIG.allow), false);
    assert.equal(isAllowed('BSD*', CONFIG.allow), false);
  });
});

describe('judge', () => {
  it('passes a report whose every licence is allowed and counts its packages', () => {
    assert.deepEqual(judge({ 'a@1.0.0': { licenses: 'MIT' }, 'b@1.0.0': { licenses: 'ISC' } }, CONFIG), { lines: ['license-check: 2 packages, every licence allowed exactly'], status: 0 });
  });

  it('fails a report with a licence not on the list and names each package', () => {
    assert.deepEqual(judge({ 'a@1.0.0': { licenses: 'MIT' }, 'b@1.0.0': { licenses: 'BUSL-1.1' } }, CONFIG), {
      lines: ['license-check: 1 of 2 packages have a licence not on the allow list:', '  b@1.0.0  BUSL-1.1'],
      status: 1,
    });
  });

  it('fails closed on output that is not an object, judging nothing', () => {
    const unreadable = { lines: ['license-check: unreadable pnpm licenses output'], status: 2 };
    assert.deepEqual(judge(null, CONFIG), unreadable);
    assert.equal(judge('text', CONFIG).status, 2);
    assert.deepEqual(judge([], CONFIG), unreadable);
  });

  it('judges a package listed under two licences against both', () => {
    const twice = fromPnpm({
      MIT: [{ name: 'a', versions: ['1.0.0'] }],
      'GPL-3.0': [{ name: 'a', versions: ['1.0.0'] }],
      ISC: [
        { name: 'b', versions: ['1.0.0'] },
        { name: 'b', versions: ['1.0.0'] },
      ],
    });
    assert.deepEqual(twice, { 'a@1.0.0': { licenses: '(MIT) AND (GPL-3.0)' }, 'b@1.0.0': { licenses: 'ISC' } });
    assert.deepEqual(judge(twice, CONFIG), {
      lines: ['license-check: 1 of 2 packages have a licence not on the allow list:', '  a@1.0.0  (MIT) AND (GPL-3.0)'],
      status: 1,
    });
  });

  it('fails an empty inventory, which judged no package', () => {
    const empty = { lines: ['license-check: pnpm licenses listed no packages to judge'], status: 2 };
    assert.deepEqual(judge({}, CONFIG), empty);
    assert.deepEqual(judge(fromPnpm({}), CONFIG), empty);
    assert.deepEqual(judge(fromPnpm({ MIT: [] }), CONFIG), empty);
  });
});

describe('fromPnpm', () => {
  it('keys each version of each package by name@version, with its group licence', () => {
    assert.deepEqual(
      fromPnpm({
        MIT: [
          { name: 'a', versions: ['1.0.0', '2.0.0'], license: 'MIT' },
          { name: '@s/b', versions: ['3.0.0'], license: 'MIT' },
        ],
        Unknown: [{ name: 'c', versions: ['0.0.1'], license: 'Unknown' }],
      }),
      { 'a@1.0.0': { licenses: 'MIT' }, 'a@2.0.0': { licenses: 'MIT' }, '@s/b@3.0.0': { licenses: 'MIT' }, 'c@0.0.1': { licenses: 'Unknown' } },
    );
  });

  for (const [label, output] of [
    ['null', null],
    ['an array', []],
    ['text', 'MIT'],
    ['a group that is not a list', { MIT: { name: 'a' } }],
    ['an entry with no name', { MIT: [{ versions: ['1.0.0'] }] }],
    ['an entry with no versions', { MIT: [{ name: 'a' }] }],
    ['an entry with an empty version list', { MIT: [{ name: 'a', versions: [] }] }],
    ['a version that is not text', { MIT: [{ name: 'a', versions: [1] }] }],
    ['a null entry', { MIT: [null] }],
  ] as const) {
    it(`reads ${label} as unreadable`, () => {
      assert.equal(fromPnpm(output), null);
    });
  }

  it("refuses the packages pnpm reports Unknown unless they're named", () => {
    assert.deepEqual(
      judge(
        fromPnpm({
          Unknown: [
            { name: 'old-pkg', versions: ['0.0.1'] },
            { name: 'old-pkg', versions: ['0.0.2'] },
          ],
          bsd: [{ name: 'legacy-stream', versions: ['1.0.4'] }],
        }),
        CONFIG,
      ),
      { lines: ['license-check: 1 of 3 packages have a licence not on the allow list:', '  old-pkg@0.0.2  Unknown'], status: 1 },
    );
  });
});

describe('pnpmLicenses', () => {
  it("asks pnpm at the root for every workspace's licences as JSON text, with room for a large tree", () => {
    const calls: unknown[][] = [];
    const exec: Exec = (file, args, options) => {
      calls.push([file, args, options]);
      return '{}';
    };
    assert.equal(pnpmLicenses(exec)('/repo'), '{}');
    assert.deepEqual(calls, [['pnpm', ['licenses', 'list', '--json', '--recursive'], { cwd: '/repo', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }]]);
  });

  it('runs the program by default and returns what it prints', () => {
    const dir = temp();
    assert.equal(execFile(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir, encoding: 'utf8', maxBuffer: 1024 }).endsWith(dir.split('/').pop() as string), true);
  });
});

describe('runLicenseCheck', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
  };

  it('judges the list pnpm prints when no report is given', () => {
    let ran = 0;
    const c = capture();
    const status = runLicenseCheck({ config: CONFIG, root: '/repo' }, (root) => {
      ran += 1;
      assert.equal(root, '/repo');
      return JSON.stringify({ 'GPL-3.0': [{ name: 'a', versions: ['1.0.0'] }] });
    }, c.io);
    assert.equal(ran, 1);
    assert.equal(status, 1);
    assert.equal(c.out[1], '  a@1.0.0  GPL-3.0');
  });

  it('reads a saved list from the report given, without running pnpm', () => {
    const file = join(temp(), 'report.json');
    writeFileSync(file, JSON.stringify({ MIT: [{ name: 'a', versions: ['1.0.0'] }] }));
    const c = capture();
    const status = runLicenseCheck({ config: CONFIG, root: '/repo', report: file }, () => {
      throw new Error('pnpm must not run');
    }, c.io);
    assert.equal(status, 0);
    assert.deepEqual(c.out, ['license-check: 1 packages, every licence allowed exactly']);
  });

  it("fails closed on license-checker's old report shape", () => {
    const c = capture();
    assert.equal(runLicenseCheck({ config: CONFIG, root: '.' }, () => JSON.stringify({ 'a@1.0.0': { licenses: 'MIT' } }), c.io), 2);
    assert.deepEqual(c.err, ['license-check: unreadable pnpm licenses output']);
    assert.deepEqual(c.out, []);
  });

  it('throws, naming the source, when pnpm prints something other than JSON', () => {
    const c = capture();
    assert.throws(() => runLicenseCheck({ config: CONFIG, root: '.' }, () => 'ERR_PNPM_NETWORK', c.io), /^Error: cannot read pnpm licenses list: .*JSON/);
    assert.deepEqual([c.out, c.err], [[], []]);
  });

  it('throws, naming the source, when pnpm cannot run, or the report is missing', () => {
    const c = capture();
    assert.throws(
      () =>
        runLicenseCheck({ config: CONFIG, root: '.' }, () => {
          throw new Error('spawn pnpm ENOENT');
        }, c.io),
      { message: 'cannot read pnpm licenses list: spawn pnpm ENOENT' },
    );
    assert.throws(() => runLicenseCheck({ config: CONFIG, root: '.', report: join(temp(), 'none.json') }, () => '{}', c.io), /^Error: cannot read .*none\.json: ENOENT/);
    assert.deepEqual([c.out, c.err], [[], []]);
  });
});
