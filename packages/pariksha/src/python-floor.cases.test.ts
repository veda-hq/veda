// python-floor end to end: the packaged script, through the CLI as a product
// runs it, under a real interpreter, on throwaway repositories. The cases are
// the original check's own, so the port is held to what the original refused.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const CLI = join(import.meta.dirname, 'cli.ts');
const FLOOR_FILE = 'scripts/lib/python-floor';

/**
 * An interpreter at or above 3.`minor`: PARIKSHA_TEST_PYTHON when it meets
 * it, else the first plain or versioned python3 on PATH that does. A machine
 * with none fails the suite rather than skipping it.
 */
const pythonAtLeast = (minor: number): string => {
  const named = process.env.PARIKSHA_TEST_PYTHON;
  const candidates = [...(named === undefined ? [] : [named]), 'python3', 'python3.15', 'python3.14', 'python3.13', 'python3.12', 'python3.11'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8' });
    const [major, found] = probe.stdout === null ? [] : probe.stdout.trim().split(' ').map(Number);
    if (probe.status === 0 && major === 3 && found !== undefined && found >= minor) return candidate;
  }
  throw new Error(`no Python >= 3.${String(minor)} among ${candidates.join(', ')}; set PARIKSHA_TEST_PYTHON`);
};
const PYTHON = pythonAtLeast(11);

const made: string[] = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

const gitAdd = (root: string): void => {
  execFileSync('git', ['add', '-A'], { cwd: root, env: ENV });
};

/** A throwaway repository with `files` and a floor file staged. */
const fixture = (files: Record<string, string>, floor = '3.11'): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-python-floor-')));
  made.push(root);
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  writeFileSync(join(root, FLOOR_FILE), `${floor}\n`);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  execFileSync('git', ['init', '-q', '.'], { cwd: root, env: ENV });
  gitAdd(root);
  return root;
};

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}

/** `pariksha python-floor` on `root`, from inside it. */
const guard = (root: string, extra: readonly string[] = [], python = PYTHON): Run => {
  const r = spawnSync(process.execPath, [CLI, 'python-floor', '--python', python, '--floor-file', FLOOR_FILE, ...extra], { cwd: root, env: ENV, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: `${r.stdout}${r.stderr}` };
};

describe('pariksha python-floor: a repository against its floor', () => {
  it('passes clean sources, on stdout, naming the floor file', () => {
    const run = guard(fixture({ 'ok.py': 'VALUE = 1\n', 'hook.sh': '#!/usr/bin/env bash\npython3 - <<PY\nimport os\nPY\n' }));
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '✅ 2 Python source(s) run on Python 3.11 (scripts/lib/python-floor)\n');
    assert.equal(run.stderr, '');
  });

  it('diagnoses a PEP 604 annotation in a heredoc and a too-new import on a 3.9 floor', () => {
    const run = guard(
      fixture(
        {
          'runner.sh': '#!/usr/bin/env bash\npython3 - <<PY\ndef blob() -> bytes | None:\n    return None\nPY\n',
          'ports.py': 'import tomllib\n',
        },
        '3.9',
      ),
    );
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /runner\.sh <<PY:3/);
    assert.match(run.stderr, /runtime-pep604/);
    assert.match(run.stderr, /ports\.py:1/);
    assert.match(run.stderr, /tomllib was added in Python 3\.11/);
    assert.match(run.stderr, /raise scripts\/lib\/python-floor, or use a module the floor has/);
  });

  it('takes --root, and reads a ./ floor file as the same index path', () => {
    const root = fixture({ 'ok.py': 'VALUE = 1\n' });
    const r = spawnSync(process.execPath, [CLI, 'python-floor', '--python', PYTHON, '--floor-file', `./${FLOOR_FILE}`, '--root', root], { cwd: tmpdir(), env: ENV, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '✅ 1 Python source(s) run on Python 3.11 (scripts/lib/python-floor)\n');
  });
});

describe('pariksha python-floor: detection', () => {
  it('rejects syntax newer than the floor', () => {
    const run = guard(fixture({ 'newer.py': 'type Alias = int\n' }));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /syntax-too-new/);
    assert.match(run.stderr, /newer\.py:1/);
    assert.match(run.stderr, /rewrite for the declared floor, or raise scripts\/lib\/python-floor/);
    assert.match(run.stderr, /^❌ Python that cannot run on the declared floor 3\.11 \(scripts\/lib\/python-floor\):\n/);
  });

  it('skips what --exclude matches and still judges a live file', () => {
    const root = fixture({
      'archive/0089/old.py': 'type Alias = int\n',
      'notes/old.sh': 'python3 - <<PY\nimport annotationlib\nPY\n',
      'archive/README.sh': 'python3 - <<PY\nimport annotationlib\nPY\n',
      'live.py': 'type Alias = int\n',
    });
    const run = guard(root, ['--exclude', String.raw`^archive/(?!README\.sh$)|^notes/`]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /live\.py:1/);
    assert.match(run.stderr, /archive\/README\.sh <<PY:2/);
    assert.doesNotMatch(run.stderr, /archive\/0089/);
    assert.doesNotMatch(run.stderr, /notes\//);
    // Without --exclude nothing is skipped.
    const all = guard(root);
    assert.match(all.stderr, /archive\/0089\/old\.py:1/);
    assert.match(all.stderr, /notes\/old\.sh <<PY:2/);
  });

  it('refuses an --exclude that is not a regular expression, before checking anything', () => {
    const run = guard(fixture({ 'ok.py': 'VALUE = 1\n' }), ['--exclude', '(']);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /--exclude is not a regular expression: missing \), unterminated subpattern/);
  });

  it('rejects a stdlib module added after the floor, inside a heredoc', () => {
    const run = guard(fixture({ 'hook.sh': '#!/usr/bin/env bash\npython3 - <<PY\nimport annotationlib\nPY\n' }));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /stdlib-too-new/);
    assert.match(run.stderr, /hook\.sh <<PY:3/);
  });

  it('rejects a stdlib module removed at the floor, inside a `python3 -c` payload', () => {
    const run = guard(fixture({ 'inline.sh': "#!/usr/bin/env bash\npython3 -c 'import distutils'\n" }, '3.12'), [], pythonAtLeast(12));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /stdlib-removed/);
    assert.match(run.stderr, /inline\.sh python -c:2/);
  });

  it('accepts a PEP 604 annotation on a floor that can evaluate it', () => {
    const source = 'def f(x: int | None) -> str | None:\n    return None\n';
    assert.equal(guard(fixture({ 'u.py': source })).status, 0);
  });

  it('rejects the same annotation on a floor that cannot, unless deferred', () => {
    const source = 'def f(x: int | None) -> str | None:\n    return None\n';
    const bare = guard(fixture({ 'u.py': source }, '3.9'));
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /runtime-pep604/);
    const deferred = guard(fixture({ 'u.py': `from __future__ import annotations\n${source}` }, '3.9'));
    assert.equal(deferred.status, 0);
  });

  it('does not mistake bitwise-or and set union for a type union', () => {
    const source = ['import os', 'FLAGS = os.O_RDONLY | os.O_NOFOLLOW', 'NAMES = {"a"} | {"b"}', 'MERGED = {"a": 1} | {"b": 2}', ''].join('\n');
    assert.equal(guard(fixture({ 'ops.py': source }, '3.9')).status, 0);
  });

  it('still catches a deferred-annotation escape that is evaluated anyway', () => {
    const source = ['from __future__ import annotations', 'from typing import cast', 'value = cast(int | None, 1)', ''].join('\n');
    const run = guard(fixture({ 'c.py': source }, '3.9'));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /outside an annotation/);
  });

  it('checks a Python file in a declared non-UTF-8 encoding rather than skipping it', () => {
    const root = fixture({});
    // latin-1: 0xE9 is a valid é and an invalid UTF-8 start byte.
    writeFileSync(join(root, 'latin.py'), '# -*- coding: latin-1 -*-\nCAF\xe9 = "caf\xe9"\ntype Alias = int\n', 'latin1');
    gitAdd(root);
    const run = guard(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /syntax-too-new/);
    assert.match(run.stderr, /latin\.py/);
  });

  it('reports a file it cannot decode at all instead of passing over it', () => {
    const root = fixture({});
    // No coding declaration, and 0xFF is not valid UTF-8 or a legal default.
    writeFileSync(join(root, 'broken.py'), Buffer.from([0xff, 0xfe, 0x41, 0x0a]));
    gitAdd(root);
    const run = guard(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /unreadable/);
    assert.match(run.stderr, /broken\.py/);
  });

  it('reports a coding declaration that names no codec', () => {
    const root = fixture({ 'bad.py': '# -*- coding: no-such-codec -*-\nVALUE = 1\n' });
    const run = guard(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /bad\.py:1\n {6}unreadable: SyntaxError: unknown encoding: no-such-codec/);
  });

  it('strips leading tabs from a <<- heredoc, as the shell does', () => {
    const run = guard(fixture({ 'dash.sh': '#!/usr/bin/env bash\npython3 - <<-PY\n\timport os\n\tprint(os.name)\n\tPY\n' }));
    assert.doesNotMatch(run.output, /syntax-too-new/);
    assert.equal(run.status, 0);
  });

  it('reports a tracked symlink rather than judging its target path as source', () => {
    const root = fixture({ 'real.py': 'VALUE = 1\n' });
    symlinkSync('real.py', join(root, 'link.py'));
    gitAdd(root);
    const run = guard(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /link\.py:1/);
    assert.match(run.stderr, /a symlink/);
  });

  it('fails loudly rather than passing when it finds nothing to scan', () => {
    const run = guard(fixture({}));
    assert.equal(run.status, 2);
    assert.match(run.stderr, /the scan is broken rather than the repo clean/);
  });

  it('refuses to judge when its own interpreter is below the floor, naming the --selector when given', () => {
    const root = fixture({ 'ok.py': 'VALUE = 1\n' }, '3.99');
    const bare = guard(root);
    assert.equal(bare.status, 2);
    assert.equal(bare.stdout, '');
    assert.match(bare.stderr, /below the declared floor 3\.99, so it cannot judge the floor\.\n {3}Run it under a newer interpreter\.\n$/);
    const named = guard(root, ['--selector', 'scripts/pick-python.sh']);
    assert.equal(named.status, 2);
    assert.match(named.stderr, /\n {3}Run it under a newer interpreter \(the hook does this for you via scripts\/pick-python\.sh\)\.\n$/);
  });

  it('refuses a floor file that is not in the index', () => {
    const root = fixture({ 'ok.py': 'VALUE = 1\n' });
    const r = spawnSync(process.execPath, [CLI, 'python-floor', '--python', PYTHON, '--floor-file', 'elsewhere/python-floor'], { cwd: root, env: ENV, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'elsewhere/python-floor is not in the index, so there is no declared floor\n');
  });
});

describe('pariksha python-floor: what the gate reads', () => {
  const HOOK = '#!/usr/bin/env bash\npython3 - <<PY\nimport os\nPY\n';

  it('passes a tracked file deleted on disk with the deletion unstaged', () => {
    const root = fixture({ 'ok.py': 'VALUE = 1\n', 'hook.sh': HOOK });
    unlinkSync(join(root, 'hook.sh'));
    const run = guard(root);
    assert.doesNotMatch(run.output, /unreadable/);
    assert.equal(run.status, 0);
  });

  it('still judges the staged copy of a file deleted on disk', () => {
    const root = fixture({ 'ok.py': 'VALUE = 1\n', 'hook.sh': '#!/usr/bin/env bash\npython3 - <<PY\nimport annotationlib\nPY\n' });
    unlinkSync(join(root, 'hook.sh'));
    const run = guard(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /hook\.sh <<PY:3/);
    assert.match(run.stderr, /stdlib-too-new/);
  });

  it('refuses a broken staged file whose copy on disk was repaired but not staged', () => {
    const root = fixture({ 'newer.py': 'type Alias = int\n' });
    writeFileSync(join(root, 'newer.py'), 'Alias = int\n');
    const run = guard(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /syntax-too-new/);
    assert.match(run.stderr, /newer\.py:1/);
  });

  it('refuses a staged Python file it cannot decode, whatever is on disk', () => {
    const root = fixture({ 'ok.py': 'VALUE = 1\n' });
    writeFileSync(join(root, 'broken.py'), Buffer.from([0xff, 0xfe, 0x41, 0x0a]));
    gitAdd(root);
    writeFileSync(join(root, 'broken.py'), 'VALUE = 2\n');
    const run = guard(root);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /broken\.py:1/);
    assert.match(run.stderr, /unreadable/);
  });

  it('does not refuse an unstaged edit the commit leaves out', () => {
    const root = fixture({ 'ok.py': 'VALUE = 1\n' });
    writeFileSync(join(root, 'ok.py'), 'type Alias = int\n');
    const run = guard(root);
    assert.doesNotMatch(run.output, /syntax-too-new/);
    assert.equal(run.status, 0);
  });

  it('reads the declared floor from the index too', () => {
    const root = fixture({ 'u.py': 'def f(x: int | None) -> None:\n    return None\n' });
    writeFileSync(join(root, FLOOR_FILE), '3.9\n');
    const run = guard(root);
    assert.match(run.output, /Python 3\.11/);
    assert.equal(run.status, 0);
  });

  it('refuses a floor file staged as a symlink whose target reads as a version', () => {
    const root = fixture({ 'ok.py': 'VALUE = 1\n' });
    unlinkSync(join(root, FLOOR_FILE));
    symlinkSync('3.11', join(root, FLOOR_FILE));
    gitAdd(root);
    const run = guard(root);
    assert.match(run.output, /must be a regular file in the index/);
    assert.notEqual(run.status, 0);
  });
});
