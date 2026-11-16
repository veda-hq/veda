// The workflow and compose rules of repo-rules, each first on its lesson's own incident.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memoryRepo } from './repo-rules-memory.ts';
import {
  actionsPathLeadingSlash,
  falsyTernaryExpression,
  isAction,
  isCompose,
  isWorkflow,
  jobLevelIfNotStep,
  jobsOf,
  jobTimeoutMinutes,
  pgIsreadyOverSocket,
  probesOverTcp,
  triggersOf,
  yamlOf,
} from './repo-rules-workflows.ts';

const W = '.github/workflows/ci.yml';

describe('file kinds', () => {
  it('names workflows, actions and compose files', () => {
    assert.equal(isWorkflow('.github/workflows/ci.yml'), true);
    assert.equal(isWorkflow('.github/workflows/ci.yaml'), true);
    assert.equal(isWorkflow('.github/workflows/sub/ci.yml'), false);
    assert.equal(isWorkflow('ci.yml'), false);
    assert.equal(isAction('.github/actions/setup/action.yml'), true);
    assert.equal(isAction('action.yaml'), true);
    assert.equal(isAction('my-action.yml'), false);
    for (const p of ['compose.yml', 'docker-compose.yml', 'docker-compose.test.yaml', 'infra/compose.dev.yml']) assert.equal(isCompose(p), true, p);
    assert.equal(isCompose('composer.yml'), false);
  });
});

describe('YAML reading', () => {
  it('reads what parses and nothing else', () => {
    assert.deepEqual(yamlOf('a: 1'), { a: 1 });
    assert.equal(yamlOf('a: [1'), undefined);
  });

  it('reads triggers in all three spellings', () => {
    assert.deepEqual([...triggersOf({ on: 'push' }).keys()], ['push']);
    assert.deepEqual([...triggersOf({ on: ['push', 3, 'merge_group'] }).keys()], ['push', 'merge_group']);
    assert.deepEqual([...triggersOf({ on: { pull_request: { paths: ['a'] } } })], [['pull_request', { paths: ['a'] }]]);
    assert.equal(triggersOf({ on: 3 }).size, 0);
    assert.equal(triggersOf('x').size, 0);
  });

  it('reads jobs that are objects', () => {
    assert.deepEqual(jobsOf({ jobs: { a: { steps: [] }, b: 'x' } }), [['a', { steps: [] }]]);
    assert.deepEqual(jobsOf({ jobs: [] }), []);
    assert.deepEqual(jobsOf(null), []);
  });
});

describe('actions-path-leading-slash', () => {
  it('refuses the incident: a reviewer-suggested leading slash that stopped the workflow', () => {
    const repo = memoryRepo({ [W]: 'on:\n  pull_request:\n    paths:\n      - "/apps/**"\n      - "packages/**"\n    paths-ignore:\n      - "!/docs/**"\n  push: {}\njobs: {}\n' });
    assert.deepEqual(actionsPathLeadingSlash.run(repo, {}), [
      { file: W, line: 4, detail: 'on.pull_request.paths pattern "/apps/**" starts with "/"' },
      { file: W, line: 7, detail: 'on.pull_request.paths-ignore pattern "!/docs/**" starts with "/"' },
    ]);
  });

  it('passes root-relative patterns, other files and non-list filters', () => {
    const repo = memoryRepo({
      [W]: 'on:\n  pull_request:\n    paths: ["apps/**", 3]\n    paths-ignore: docs\n  push:\n',
      'docs/ci.yml': 'on:\n  push:\n    paths: ["/x"]\n',
    });
    assert.deepEqual(actionsPathLeadingSlash.run(repo, {}), []);
  });

  it('finds a pattern written in a flow list, with no line when the text differs', () => {
    const repo = memoryRepo({ [W]: "on: { push: { paths: ['/a'] } }\n" });
    assert.deepEqual(actionsPathLeadingSlash.run(repo, {}), [{ file: W, line: 1, detail: 'on.push.paths pattern "/a" starts with "/"' }]);
    const escaped = memoryRepo({ [W]: 'on: { push: { paths: ["\\x2Fa"] } }\n' });
    assert.deepEqual(actionsPathLeadingSlash.run(escaped, {}), [{ file: W, detail: 'on.push.paths pattern "/a" starts with "/"' }]);
  });

  it('skips a selected file that is gone', () => {
    assert.deepEqual(actionsPathLeadingSlash.run(memoryRepo({}, { selected: [W] }), {}), []);
  });
});

describe('falsy-ternary-expression', () => {
  it('refuses the incident: `cond && 0 || 1` that always gave 1', () => {
    const repo = memoryRepo({ [W]: "jobs:\n  a:\n    env:\n      RETRIES: ${{ github.event_name == 'push' && 0 || 1 }}\n" });
    assert.deepEqual(falsyTernaryExpression.run(repo, {}), [{ file: W, line: 4, detail: '`&& 0 ||` always takes the right-hand side' }]);
  });

  it("refuses each falsy literal, in actions too, and passes a quoted '0' and comments", () => {
    const action = '.github/actions/x/action.yml';
    const repo = memoryRepo({
      [action]: ["a: ${{ x && '' || 'y' }}", 'b: ${{ x && "" || 1 }}', 'c: ${{ x && false || true }}', 'd: ${{ x && null || 2 }}', "ok: ${{ x && '0' || '1' }}", '# note: x && 0 || 1', 'e: 1 # x && 0 || 1'].join('\n'),
      'README.md': 'x && 0 || 1',
    });
    assert.deepEqual(
      falsyTernaryExpression.run(repo, {}).map((f) => f.line),
      [1, 2, 3, 4],
    );
    assert.deepEqual(falsyTernaryExpression.run(memoryRepo({}, { selected: [W] }), {}), []);
  });
});

describe('job-level-if-not-step', () => {
  it('refuses the incident: a job whose every step skips still starts and bills', () => {
    const repo = memoryRepo({ [W]: 'on: push\njobs:\n  mobile:\n    runs-on: ubuntu-latest\n    steps:\n      - if: env.MOBILE == 1\n        run: a\n      - if: env.MOBILE == 1\n        run: b\n' });
    assert.deepEqual(jobLevelIfNotStep.run(repo, {}), [{ file: W, line: 3, detail: 'job "mobile" has no if:, and each of its 2 step(s) has one' }]);
  });

  it('passes a job with its own if:, a step without one, no steps, and a reusable job', () => {
    const repo = memoryRepo({
      [W]: [
        'on: push',
        'jobs:',
        '  a:',
        '    if: x',
        '    steps: [{ if: y, run: a }]',
        '  b:',
        '    steps: [{ if: y, run: a }, { run: b }]',
        '  c:',
        '    steps: []',
        '  d:',
        '    uses: ./.github/workflows/x.yml',
        '  e:',
        '    steps: ["x"]',
      ].join('\n'),
    });
    assert.deepEqual(jobLevelIfNotStep.run(repo, {}), []);
  });

  it('gives no line when the job id is not written as a key', () => {
    const repo = memoryRepo({ [W]: 'on: push\njobs: { "a b": { steps: [{ if: x, run: y }] } }\n' });
    assert.deepEqual(jobLevelIfNotStep.run(repo, {}), [{ file: W, detail: 'job "a b" has no if:, and each of its 1 step(s) has one' }]);
  });
});

describe('job-timeout-minutes', () => {
  it('refuses the incident: a queued job with GitHub\'s 360-minute default that timed out the queue', () => {
    const repo = memoryRepo({ [W]: 'on:\n  pull_request:\n  merge_group:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: [{ run: x }]\n  lint:\n    timeout-minutes: 10\n    steps: [{ run: x }]\n  call:\n    uses: ./.github/workflows/r.yml\n' });
    assert.deepEqual(jobTimeoutMinutes.run(repo, {}), [{ file: W, line: 5, detail: 'job "test" has no timeout-minutes (the workflow runs on pull_request, merge_group)' }]);
  });

  it('passes workflows no queue waits on, and reads the triggers setting', () => {
    const repo = memoryRepo({ [W]: 'on: [push, schedule]\njobs:\n  a:\n    steps: [{ run: x }]\n' });
    assert.deepEqual(jobTimeoutMinutes.run(repo, {}), []);
    assert.deepEqual(
      jobTimeoutMinutes.run(repo, { triggers: ['push'] }).map((f) => f.detail),
      ['job "a" has no timeout-minutes (the workflow runs on push)'],
    );
    assert.equal(jobTimeoutMinutes.settings?.['triggers']?.(['push']), undefined);
    assert.match(jobTimeoutMinutes.settings?.['triggers']?.([]) ?? '', /non-empty list/);
  });
});

describe('pg-isready-over-socket', () => {
  it('reads a probe over TCP', () => {
    assert.equal(probesOverTcp('pg_isready -h 127.0.0.1'), true);
    assert.equal(probesOverTcp('pg_isready -h127.0.0.1 -U x'), true);
    assert.equal(probesOverTcp('pg_isready --host=db'), true);
    assert.equal(probesOverTcp('pg_isready --host db'), true);
    assert.equal(probesOverTcp('pg_isready -U postgres'), false);
    assert.equal(probesOverTcp('PGHOST=-h pg_isready'), false);
  });

  it('refuses the incident: a compose healthcheck over the socket that passed mid-init', () => {
    const repo = memoryRepo({
      'docker-compose.yml': 'services:\n  db:\n    image: postgres:18\n    healthcheck:\n      test: ["CMD", "pg_isready", "-U", "postgres"]\n  ok:\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1"]\n  str:\n    healthcheck: { test: pg_isready }\n  none: {}\n  other:\n    healthcheck: { test: 3 }\n',
    });
    assert.deepEqual(pgIsreadyOverSocket.run(repo, {}), [
      { file: 'docker-compose.yml', line: 5, detail: 'healthcheck `pg_isready -U postgres` probes over the socket' },
      { file: 'docker-compose.yml', line: 5, detail: 'healthcheck `pg_isready` probes over the socket' },
    ]);
  });

  it('refuses a workflow service whose --health-cmd probes the socket', () => {
    const repo = memoryRepo({
      [W]: [
        'on: push',
        'jobs:',
        '  a:',
        '    services:',
        '      pg:',
        '        image: postgres',
        '        options: >-',
        '          --health-cmd pg_isready',
        '          --health-interval 2s',
        '      tcp:',
        '        options: --health-cmd "pg_isready -h localhost" --health-retries 5',
        '      redis:',
        '        options: --health-cmd "redis-cli ping"',
        '      bare: {}',
        '      word: x',
        '  b:',
        '    services: []',
      ].join('\n'),
      'compose.yml': 'services: []\n',
      'compose.dev.yml': 'x: 1\n',
    });
    assert.deepEqual(pgIsreadyOverSocket.run(repo, {}), [{ file: W, line: 8, detail: 'healthcheck `pg_isready` probes over the socket' }]);
  });
});
