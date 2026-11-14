import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkGates, consumedNeeds, DEFAULT_GATE_CONFIG, dispatchMessage, findDispatchedGates, findGateGaps, hasDispatch, parseGateConfig, workflowFiles, type GateConfig } from './aggregate-gate-needs.ts';

const temps: string[] = [];
/** A fresh temporary directory, removed when this file's tests end. */
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * A tree's gates may all be complete, and a check reporting zero looks like a
 * check doing nothing; the fixtures reproduce the gaps that reached review in
 * the project this came from, so a regression to a no-op fails here.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const CONFIG: GateConfig = { ...DEFAULT_GATE_CONFIG, nonGating: new Set(['detect-changes']) };

const fixture = (body: string): { root: string; names: string[] } => {
  const root = temp('pariksha-gate-');
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

describe('findDispatchedGates', () => {
  const PROBE = join('.github', 'workflows', 'probe.yml');
  const GATED = ['jobs:', '  build: {}', '  ci-gate:', '    name: CI Gate', '    needs: [build]', ''];
  const dispatched = (on: readonly string[], config: GateConfig = CONFIG) => {
    const { root, names } = fixture([...on, ...GATED].join('\n'));
    return findDispatchedGates(root, names, config);
  };

  it('passes this repository’s own workflows', () => {
    assert.deepEqual(findDispatchedGates(REPO_ROOT, workflowFiles(REPO_ROOT, '.github/workflows'), CONFIG), []);
  });

  it('finds dispatch beside a gate in every shape `on:` takes', () => {
    const shapes: string[][] = [
      ['on: workflow_dispatch'],
      ['on: [pull_request, workflow_dispatch]'],
      ['on:', '  - merge_group', '  - workflow_dispatch'],
      ['on:', '  pull_request:', '  workflow_dispatch:'],
      ['on:', '  workflow_dispatch:', '    inputs:', '      reason:', '        type: string'],
      ['"on": { workflow_dispatch: {} }'],
    ];
    for (const on of shapes) assert.deepEqual(dispatched(on), [{ workflow: PROBE, gate: 'ci-gate' }], on.join(' / '));
  });

  it('passes a gate workflow with no dispatch, and dispatch with no gate', () => {
    assert.deepEqual(dispatched(['on: [pull_request, merge_group]']), []);
    assert.deepEqual(dispatched(['on:', '  pull_request:', '  workflow_call:']), []);
    assert.deepEqual(dispatched(['on: pull_request']), []);
    assert.deepEqual(dispatched([]), []);
    const { root, names } = fixture('on: workflow_dispatch\njobs:\n  build: {}\n  release: {}\n');
    assert.deepEqual(findDispatchedGates(root, names, CONFIG), []);
  });

  it('reads a job id, not only a name, as a gate, and names every gate', () => {
    const { root, names } = fixture('on: workflow_dispatch\njobs:\n  security-gate: {}\n  x:\n    name: Merge Gate\n');
    assert.deepEqual(findDispatchedGates(root, names, CONFIG), [
      { workflow: PROBE, gate: 'security-gate' },
      { workflow: PROBE, gate: 'x' },
    ]);
  });

  it('lets a workflow the config allows by file name be dispatched', () => {
    assert.deepEqual(dispatched(['on: workflow_dispatch'], { ...CONFIG, dispatchAllowed: new Set(['probe.yml']) }), []);
    assert.equal(dispatched(['on: workflow_dispatch'], { ...CONFIG, dispatchAllowed: new Set(['other.yml']) }).length, 1);
  });

  it('leaves an unparseable or scalar workflow to the needs check', () => {
    const broken = fixture('on: workflow_dispatch\njobs:\n  - [unbalanced\n');
    assert.deepEqual(findDispatchedGates(broken.root, broken.names, CONFIG), []);
    const scalar = fixture('workflow_dispatch\n');
    assert.deepEqual(findDispatchedGates(scalar.root, scalar.names, CONFIG), []);
  });
});

describe('hasDispatch', () => {
  it('reads one event, a list and a map, and nothing else', () => {
    assert.equal(hasDispatch('workflow_dispatch'), true);
    assert.equal(hasDispatch(['push', 'workflow_dispatch']), true);
    assert.equal(hasDispatch({ workflow_dispatch: null }), true);
    for (const on of [undefined, null, 'push', ['push'], { push: null }, 3]) assert.equal(hasDispatch(on), false, JSON.stringify(on));
  });
});

describe('dispatchMessage', () => {
  it('names the workflow and the gate, under its own id', () => {
    assert.equal(
      dispatchMessage({ workflow: 'ci.yml', gate: 'ci-gate' }),
      "❌ dispatch-on-gate-workflow: ci.yml: workflow_dispatch on the workflow holding the required gate ci-gate. A dispatch run posts the gate as skipped on the PR's head commit, which a merge queue reads as failed and dequeues the PR. Move ad-hoc runs to a separate workflow with no gate-named job.",
    );
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
    const root = temp('pariksha-gate-');
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
    const config = parseGateConfig(JSON.stringify({ id: 'CI-1', workflowsDir: 'ci', gateName: '^merge$', nonGating: ['detect'], dispatchAllowed: ['release.yml'] }));
    assert.equal(config.id, 'CI-1');
    assert.equal(config.workflowsDir, 'ci');
    assert.ok(config.gateName.test('MERGE'));
    assert.deepEqual([...config.nonGating], ['detect']);
    assert.deepEqual([...config.dispatchAllowed], ['release.yml']);
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
      ['{"nonGating": null}', /"nonGating" must be a list of job ids/],
      ['{"workflowsDir": null}', /"workflowsDir" must be a non-empty string/],
      ['{"gateName": null}', /"gateName" must be a non-empty string/],
      ['{"dispatchAllowed": "ci.yml"}', /"dispatchAllowed" must be a list of workflow file names/],
      ['{"dispatchAllowed": [""]}', /"dispatchAllowed" must be a list of workflow file names/],
      ['{"dispatchAllowed": null}', /"dispatchAllowed" must be a list of workflow file names/],
    ];
    for (const [text, message] of cases) assert.throws(() => parseGateConfig(text), message, text);
  });
});

describe('checkGates', () => {
  const config: GateConfig = { ...CONFIG, id: 'CI-1' };

  it('fails when there is no workflow to read', () => {
    assert.deepEqual(checkGates(temp('pariksha-gate-'), config), { ok: false, out: [], err: ['❌ CI-1: no workflow files found — the lookup failed'] });
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

  const DISPATCHED = `❌ dispatch-on-gate-workflow: ${join('.github', 'workflows', 'probe.yml')}: workflow_dispatch on the workflow holding the required gate gate. A dispatch run posts the gate as skipped on the PR's head commit, which a merge queue reads as failed and dequeues the PR. Move ad-hoc runs to a separate workflow with no gate-named job.`;

  it('refuses a complete gate its workflow can dispatch, under the dispatch id', () => {
    const { root } = fixture('on: [pull_request, workflow_dispatch]\njobs:\n  a: {}\n  gate:\n    needs: [a]\n');
    assert.deepEqual(checkGates(root, config), { ok: false, out: [], err: [DISPATCHED] });
    assert.deepEqual(checkGates(root, { ...config, dispatchAllowed: new Set(['probe.yml']) }).ok, true);
  });

  it('reports the needs gaps first, then the dispatch', () => {
    const { root } = fixture('on: workflow_dispatch\njobs:\n  a: {}\n  gate: {}\n');
    const result = checkGates(root, config);
    assert.equal(result.ok, false);
    assert.equal(result.err[0], '\n❌ CI-1: 1 aggregate gate(s) with an incomplete needs list\n');
    assert.equal(result.err.length, 5);
    assert.equal(result.err[4], DISPATCHED);
  });
});
