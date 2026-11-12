/**
 * aggregate-gate-needs against the TypeScript check it was ported from, on
 * that check's own plants. The original cannot run here (it lives in the
 * product), so each case holds what it printed, recorded by running it on
 * the same workflow with the config below: its exit code and its stderr,
 * line for line, the rule id in its messages replaced by the config's `id`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run } from './cli.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const CONFIG = { id: 'CI-001', nonGating: ['detect-changes'] };
const WHY = 'The merge queue checks only the gate. A job absent from its `needs:` cannot\nblock a merge however it fails — and a failure upstream turns into a SKIP\ndownstream, which the gate then accepts.\n';

const ported = (workflow: string): { code: number; out: string[]; err: string[] } => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-gate-parity-'));
  temps.push(root);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'probe.yml'), workflow);
  writeFileSync(join(root, 'gate.json'), JSON.stringify(CONFIG));
  const out: string[] = [];
  const err: string[] = [];
  const code = run(['aggregate-gate-needs', '--root', root, '--config', 'gate.json'], { out: (l) => out.push(l), err: (l) => err.push(l) }, '0');
  return { code: code as number, out, err };
};

describe('aggregate-gate-needs refuses what its original refuses', () => {
  it('a job omitted from the gate', () => {
    const workflow = ['on: [pull_request]', 'jobs:', '  setup:', '    runs-on: ubuntu-latest', '  dependency-review:', '    runs-on: ubuntu-latest', '  security-gate:', '    name: Security Gate', '    needs: [setup]', '    runs-on: ubuntu-latest', ''].join('\n');
    assert.deepEqual(ported(workflow), {
      code: 1,
      out: [],
      err: ['\n❌ CI-001: 1 aggregate gate(s) with an incomplete needs list\n', ' .github/workflows/probe.yml → job "security-gate"', '   not depended on: dependency-review\n', WHY],
    });
  });

  it('a non-gating job the gate reads but does not declare', () => {
    const workflow = ['on: [pull_request]', 'jobs:', '  detect-changes:', '    runs-on: ubuntu-latest', '  validation:', '    runs-on: ubuntu-latest', '  ci-gate:', '    name: CI Gate', '    needs: [validation]', "    if: needs['detect-changes'].outputs.server == 'true'", '    runs-on: ubuntu-latest', ''].join('\n');
    assert.deepEqual(ported(workflow), {
      code: 1,
      out: [],
      err: ['\n❌ CI-001: 1 aggregate gate(s) with an incomplete needs list\n', ' .github/workflows/probe.yml → job "ci-gate"', '   not depended on: detect-changes\n', WHY],
    });
  });

  it('a workflow that does not parse', () => {
    const result = ported('jobs:\n  - [unbalanced\n');
    assert.equal(result.code, 1);
    assert.deepEqual(result.err.slice(1, 3), [' .github/workflows/probe.yml → job "(unparseable)"', '   not depended on: <file did not parse>\n']);
  });

  it('and passes the gate that depends on every job', () => {
    const workflow = ['jobs:', '  setup:', '    runs-on: ubuntu-latest', '  detect-changes:', '    runs-on: ubuntu-latest', '  ci-gate:', '    name: CI Gate', '    needs: [setup]', ''].join('\n');
    assert.deepEqual(ported(workflow), { code: 0, out: ['✅ CI-001: every aggregate gate depends on all its jobs (1 workflow(s))'], err: [] });
  });
});
