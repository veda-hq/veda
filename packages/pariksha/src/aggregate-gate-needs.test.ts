import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { checkGates, consumedNeeds, DEFAULT_GATE_CONFIG, findGateGaps, parseGateConfig, workflowFiles, type GateConfig } from './aggregate-gate-needs.ts';

/**
 * A tree's gates may all be complete, and a check reporting zero looks like a
 * check doing nothing; the fixtures reproduce the gaps that reached review in
 * the project this came from, so a regression to a no-op fails here.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const CONFIG: GateConfig = { ...DEFAULT_GATE_CONFIG, nonGating: new Set(['detect-changes']) };

const fixture = (body: string): { root: string; names: string[] } => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-gate-'));
  const relative = join('.github', 'workflows', 'probe.yml');
  mkdirSync(join(root, dirname(relative)), { recursive: true });
  writeFileSync(join(root, relative), body);
  return { root, names: [relative] };
};

const gaps = (lines: readonly string[], config: GateConfig = CONFIG) => {
  const { root, names } = fixture(lines.join('\n'));
  return findGateGaps(root, names, config);
};

describe('findGateGaps', () => {
  it('passes this repository’s own workflows, and there are some', () => {
    const files = workflowFiles(REPO_ROOT, '.github/workflows');
    assert.ok(files.length > 0);
    assert.deepEqual(findGateGaps(REPO_ROOT, files, CONFIG), []);
  });

  it('catches a job omitted from the gate', () => {
    const found = gaps(['on: [pull_request]', 'jobs:', '  setup:', '    runs-on: ubuntu-latest', '  dependency-review:', '    runs-on: ubuntu-latest', '  security-gate:', '    name: Security Gate', '    needs: [setup]', '    runs-on: ubuntu-latest', '']);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]?.missing, ['dependency-review']);
  });

  it('catches an omitted upstream whose failure becomes a downstream skip', () => {
    const found = gaps(['on: [pull_request]', 'jobs:', '  check-reopen:', '    runs-on: ubuntu-latest', '  validation:', '    needs: [check-reopen]', '    runs-on: ubuntu-latest', '  ci-gate:', '    name: CI Gate', '    needs: [validation]', '    runs-on: ubuntu-latest', '']);
    assert.deepEqual(found[0]?.missing, ['check-reopen']);
  });

  const reads = (line: string) => gaps(['on: [pull_request]', 'jobs:', '  detect-changes:', '    runs-on: ubuntu-latest', '  validation:', '    runs-on: ubuntu-latest', '  ci-gate:', '    name: CI Gate', '    needs: [validation]', line, '    runs-on: ubuntu-latest', '']);

  it('catches a consumed non-gating job that the gate does not declare', () => {
    const found = reads("    if: needs.detect-changes.outputs.server == 'true'");
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]?.missing, ['detect-changes']);
  });

  it('catches a bracket-notation reference the dot regex would miss', () => {
    const found = reads("    if: needs['detect-changes'].outputs.server == 'true'");
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]?.missing, ['detect-changes']);
  });

  it('ignores a needs reference that is only a quoted string argument', () => {
    assert.deepEqual(reads("    if: contains('needs.detect-changes', 'marker')"), []);
  });

  it('reads a ${{ }} block anywhere in the gate', () => {
    assert.deepEqual(reads('    env: { X: "${{ needs.detect-changes.outputs.x }}" }')[0]?.missing, ['detect-changes']);
  });

  it('still exempts a non-gating job the gate never reads', () => {
    assert.deepEqual(reads('    timeout-minutes: 5'), []);
  });

  const steps = (...lines: string[]) => gaps(['on: [pull_request]', 'jobs:', '  detect-changes:', '    runs-on: ubuntu-latest', '  validation:', '    runs-on: ubuntu-latest', '  ci-gate:', '    name: CI Gate', '    needs: [validation]', '    runs-on: ubuntu-latest', '    steps:', ...lines, '']);

  it('does not treat literal text in a run script as a dependency', () => {
    assert.deepEqual(steps('      - run: echo "read needs.detect-changes.outputs.server here"'), []);
  });

  it('reads a step-level if:, not only the job-level one', () => {
    const found = steps('      - run: echo hi', "        if: needs.detect-changes.outputs.web == 'true'");
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]?.missing, ['detect-changes']);
  });

  it('ignores an action input that merely happens to be named `if`, and a null step', () => {
    assert.deepEqual(steps('      - uses: some/action@v1', '        with:', '          if: needs.detect-changes.outputs.web', '      -'), []);
  });

  it('accepts a gate that depends on every job, by list or by one name', () => {
    assert.deepEqual(gaps(['jobs:', '  setup:', '    runs-on: x', '  validation:', '    runs-on: x', '  ci-gate:', '    name: CI Gate', '    needs: [setup, validation]', '']), []);
    assert.deepEqual(gaps(['jobs:', '  setup:', '    runs-on: x', '  ci-gate:', '    needs: setup', '']), []);
  });

  it('does not ask a gate to depend on another gate, or count a read of an unknown job', () => {
    assert.deepEqual(gaps(['jobs:', '  a:', '    name: First Gate', '  b-gate:', '    if: needs.nowhere.result']), []);
  });

  it('ignores workflows that have no aggregate gate at all', () => {
    assert.deepEqual(gaps(['on: [push]', 'jobs:', '  build:', '    runs-on: ubuntu-latest', '']), []);
  });

  it('reports an unparseable workflow rather than passing it', () => {
    assert.deepEqual(gaps(['jobs:', '  - [unbalanced', '']), [{ workflow: join('.github', 'workflows', 'probe.yml'), gate: '(unparseable)', missing: ['<file did not parse>'] }]);
  });

  it('treats an empty or scalar workflow as having no gates, not as a crash', () => {
    assert.deepEqual(gaps(['']), []);
    assert.deepEqual(gaps(['just-a-string', '']), []);
  });

  it('still finds gaps in a real job map, so the narrowing is not swallowing everything', () => {
    const found = gaps(['jobs:', '  build:', '    runs-on: ubuntu-latest', '  gate:', '    needs: [build]', '    if: always()', '    runs-on: ubuntu-latest', '  lint:', '    runs-on: ubuntu-latest', '']);
    assert.equal(found.length, 1);
    assert.ok(found[0]?.missing.includes('lint'));
  });

  it('holds a non-gating job to the gate when the config lists none', () => {
    const strict = gaps(['jobs:', '  detect-changes: {}', '  g:', '    name: CI Gate'], DEFAULT_GATE_CONFIG);
    assert.deepEqual(strict[0]?.missing, ['detect-changes']);
  });

  it('finds gates by the configured name', () => {
    const found = gaps(['jobs:', '  build: {}', '  all-green:', '    needs: []'], { ...CONFIG, gateName: /^all-green$/i });
    assert.deepEqual(found[0]?.missing, ['build']);
  });
});

describe('consumedNeeds', () => {
  it('reads nothing of no job', () => {
    assert.deepEqual(consumedNeeds(undefined), []);
  });

  it('reads both forms once each, brackets first', () => {
    assert.deepEqual(consumedNeeds({ if: "needs.a.result && needs[ 'b' ].result && needs.a.outputs.x" }), ['b', 'a']);
  });
});

describe('workflowFiles', () => {
  it('lists .yml and .yaml files only, and none of a missing folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'pariksha-gate-'));
    mkdirSync(join(root, 'wf'));
    for (const name of ['a.yml', 'b.yaml', 'c.json']) writeFileSync(join(root, 'wf', name), '');
    assert.deepEqual(workflowFiles(root, 'wf').sort(), [join('wf', 'a.yml'), join('wf', 'b.yaml')]);
    assert.deepEqual(workflowFiles(root, 'nowhere'), []);
  });
});

describe('parseGateConfig', () => {
  it('takes the defaults for absent keys', () => {
    assert.deepEqual(parseGateConfig('{}'), DEFAULT_GATE_CONFIG);
  });

  it('reads every key, the gate name case-insensitively', () => {
    const config = parseGateConfig(JSON.stringify({ id: 'CI-1', workflowsDir: 'ci', gateName: '^merge$', nonGating: ['detect'] }));
    assert.equal(config.id, 'CI-1');
    assert.equal(config.workflowsDir, 'ci');
    assert.ok(config.gateName.test('MERGE'));
    assert.deepEqual([...config.nonGating], ['detect']);
  });

  it('refuses anything else', () => {
    const cases: Array<[string, RegExp]> = [
      ['nope', /not JSON/],
      ['[]', /must be a JSON object/],
      ['{"gates": 1}', /unknown key "gates"/],
      ['{"id": ""}', /"id" must be a non-empty string/],
      ['{"workflowsDir": 3}', /"workflowsDir" must be a non-empty string/],
      ['{"gateName": "("}', /"gateName" is not a regex/],
      ['{"nonGating": "detect"}', /"nonGating" must be a list of job ids/],
      ['{"nonGating": [""]}', /"nonGating" must be a list of job ids/],
    ];
    for (const [text, message] of cases) assert.throws(() => parseGateConfig(text), message, text);
  });
});

describe('checkGates', () => {
  const config: GateConfig = { ...CONFIG, id: 'CI-1' };

  it('fails when there is no workflow to read', () => {
    assert.deepEqual(checkGates(mkdtempSync(join(tmpdir(), 'pariksha-gate-')), config), { ok: false, out: [], err: ['❌ CI-1: no workflow files found — the lookup failed'] });
  });

  it('passes complete gates, counting the workflows', () => {
    const { root } = fixture('jobs:\n  a: {}\n  gate:\n    needs: [a]\n');
    assert.deepEqual(checkGates(root, config), { ok: true, out: ['✅ CI-1: every aggregate gate depends on all its jobs (1 workflow(s))'], err: [] });
  });

  it('names each gap, then why it matters', () => {
    const { root } = fixture('jobs:\n  a: {}\n  b: {}\n  gate:\n    name: CI Gate\n');
    assert.deepEqual(checkGates(root, config), {
      ok: false,
      out: [],
      err: [
        '\n❌ CI-1: 1 aggregate gate(s) with an incomplete needs list\n',
        ` ${join('.github', 'workflows', 'probe.yml')} → job "gate"`,
        '   not depended on: a, b\n',
        'The merge queue checks only the gate. A job absent from its `needs:` cannot\nblock a merge however it fails — and a failure upstream turns into a SKIP\ndownstream, which the gate then accepts.\n',
      ],
    });
  });
});
