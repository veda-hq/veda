// codeql-baseline, ported case for case from the script it replaces; its
// check of that repository's committed baseline is a write-then-read round
// trip here.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ALERT_SUPPRESSION, BASELINE_PATH, checkSarif, errorAlerts, newAlerts, parseBaseline, readBaseline, runCodeqlBaseline, toBaseline, type ErrorAlert } from './codeql-baseline.ts';

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codeql-baseline-'));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A result as CodeQL writes it: no `level`, so the rule's default applies. */
const result = (ruleId: string, uri: string, line: number, lineHash: string, level?: string) => ({
  ruleId,
  ...(level === undefined ? {} : { level }),
  message: { text: `${ruleId} message` },
  partialFingerprints: { primaryLocationLineHash: lineHash },
  locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }],
});

const sarif = (results: unknown[]) => ({
  runs: [
    {
      tool: {
        driver: { rules: [] },
        extensions: [
          {
            rules: [
              { id: 'js/request-forgery', defaultConfiguration: { level: 'error' } },
              { id: 'js/unused-local-variable', defaultConfiguration: { level: 'note' } },
              { id: 'js/overly-large-range', defaultConfiguration: { level: 'warning' } },
            ],
          },
        ],
      },
      results,
    },
  ],
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

describe('errorAlerts', () => {
  it('reads the level from the rule default when the result omits it, as CodeQL writes every alert', () => {
    const alerts = errorAlerts(
      sarif([result('js/request-forgery', 'src/server/a.ts', 12, 'h1:1'), result('js/unused-local-variable', 'src/server/a.ts', 3, 'h2:1'), result('js/overly-large-range', 'src/server/b.ts', 7, 'h3:1')]),
    );
    assert.deepEqual(alerts, [{ fingerprint: 'js/request-forgery|src/server/a.ts|h1:1', ruleId: 'js/request-forgery', path: 'src/server/a.ts', line: 12, message: 'js/request-forgery message' }]);
  });

  it('honours an explicit result level over the rule default, and treats unknown rules as warnings', () => {
    const alerts = errorAlerts(sarif([result('js/request-forgery', 'a.ts', 1, 'h1:1', 'warning'), result('js/overly-large-range', 'b.ts', 2, 'h2:1', 'error'), result('js/not-declared', 'c.ts', 3, 'h3:1')]));
    assert.deepEqual(
      alerts.map((alert) => alert.path),
      ['b.ts'],
    );
  });

  it('skips a result with an accepted in-source suppression, but not a rejected one', () => {
    const suppressed = (status?: string) => ({
      ...result('js/request-forgery', `${status ?? 'none'}.ts`, 1, 'h1:1'),
      suppressions: [{ kind: 'inSource', ...(status === undefined ? {} : { status }) }],
    });
    const alerts = errorAlerts(sarif([suppressed(), suppressed('accepted'), suppressed('rejected'), { ...result('js/request-forgery', 'empty.ts', 1, 'h1:1'), suppressions: [] }]));
    assert.deepEqual(
      alerts.map((alert) => alert.path),
      ['rejected.ts', 'empty.ts'],
    );
  });

  it('reads nothing from a run with no results', () => {
    assert.deepEqual(errorAlerts(sarif([])), []);
  });

  it('reads a result with no location, fingerprint or message by its rule and placeholders', () => {
    const alerts = errorAlerts({ runs: [{ results: [{ level: 'error' }] }, {}] });
    assert.deepEqual(alerts, [{ fingerprint: 'unknown|unknown|line:0', ruleId: 'unknown', path: 'unknown', line: 0, message: '' }]);
  });

  for (const [label, log] of [
    ['no runs key', {}],
    ['empty runs', { runs: [] }],
    ['runs not an array', { runs: 'x' }],
    ['null', null],
  ] as const) {
    it(`refuses a log with ${label} rather than reading it as clean`, () => {
      assert.throws(() => errorAlerts(log), /CodeQL SARIF has no runs/);
      const lines: string[] = [];
      assert.equal(
        checkSarif(log, [], (line) => lines.push(line)),
        1,
      );
      assert.deepEqual(lines, ['CodeQL: CodeQL SARIF has no runs; the analysis output is unusable']);
    });
  }
});

describe('newAlerts', () => {
  const alert = (fingerprint: string, line = 1): ErrorAlert => ({ fingerprint, ruleId: 'r', path: 'p', line, message: '' });

  it('passes alerts the baseline holds even when their line number moved', () => {
    assert.deepEqual(newAlerts([alert('r|p|h1:1', 40)], [alert('r|p|h1:1', 12)]), []);
  });

  it('reports an alert the baseline does not hold', () => {
    assert.deepEqual(newAlerts([alert('r|p|h1:1'), alert('r|p|h9:1')], [alert('r|p|h1:1')]), [alert('r|p|h9:1')]);
  });

  it('counts repeats: a second copy of a baselined alert is new', () => {
    assert.deepEqual(newAlerts([alert('r|p|h1:1'), alert('r|p|h1:1')], [alert('r|p|h1:1')]), [alert('r|p|h1:1')]);
  });
});

describe('checkSarif', () => {
  it('fails on a new error-level alert and names it', () => {
    const lines: string[] = [];
    const log = sarif([result('js/request-forgery', 'src/server/new.ts', 5, 'hn:1')]);
    assert.equal(
      checkSarif(log, [], (line) => lines.push(line)),
      1,
    );
    assert.deepEqual(lines, ['CodeQL: 1 error-level alert(s), 0 in the baseline', 'CodeQL: 1 new error-level alert(s):', '  js/request-forgery  src/server/new.ts:5  js/request-forgery message']);
  });

  it('passes when every error-level alert is baselined, and says how many baselined alerts went away', () => {
    const lines: string[] = [];
    const kept = result('js/request-forgery', 'src/server/a.ts', 12, 'h1:1');
    const baseline = errorAlerts(sarif([kept, result('js/request-forgery', 'src/server/gone.ts', 8, 'h2:1')]));
    assert.equal(
      checkSarif(sarif([kept]), baseline, (line) => lines.push(line)),
      0,
    );
    assert.deepEqual(lines, ['CodeQL: 1 error-level alert(s), 1 in the baseline; 1 baseline alert(s) no longer reported (regenerate to lock that in)']);
  });
});

describe('toBaseline', () => {
  it('sorts by fingerprint, then line, and says how it is regenerated', () => {
    const alert = (fingerprint: string, line: number): ErrorAlert => ({ fingerprint, ruleId: 'r', path: 'p', line, message: '' });
    const baseline = toBaseline([alert('b', 1), alert('a', 9), alert('a', 2), alert('c', 1)]);
    assert.deepEqual(
      baseline.alerts.map((a) => `${a.fingerprint}:${a.line.toString()}`),
      ['a:2', 'a:9', 'b:1', 'c:1'],
    );
    assert.match(baseline.description, /pariksha codeql-baseline --write; never add by hand\.$/);
  });
});

describe('parseBaseline and readBaseline', () => {
  it('reads the alerts of the file at the default path under the root, or the path given', () => {
    const root = temp();
    const alerts = errorAlerts(sarif([result('js/request-forgery', 'a.ts', 1, 'h1:1')]));
    mkdirSync(join(root, '.github/codeql'), { recursive: true });
    writeFileSync(join(root, BASELINE_PATH), JSON.stringify(toBaseline(alerts)));
    writeFileSync(join(root, 'other.json'), JSON.stringify({ description: '', alerts: [] }));
    assert.deepEqual(readBaseline(root), alerts);
    assert.deepEqual(readBaseline(root, 'other.json'), []);
  });

  for (const [label, text] of [
    ['null', 'null'],
    ['no alerts', '{"description": "x"}'],
    ['alerts not a list', '{"alerts": {}}'],
    ['an alert with no fingerprint', '{"alerts": [{"ruleId": "r"}]}'],
    ['a null alert', '{"alerts": [null]}'],
  ] as const) {
    it(`refuses ${label}, which is not a baseline`, () => {
      assert.throws(() => parseBaseline(text), /not a baseline/);
    });
  }

  it('names the query that honours suppression comments', () => {
    assert.equal(ALERT_SUPPRESSION, 'codeql/javascript-queries:AlertSuppression.ql');
  });
});

describe('runCodeqlBaseline', () => {
  const results = [result('js/request-forgery', 'src/a.ts', 12, 'h1:1'), result('js/request-forgery', 'src/a.ts', 12, 'h1:1'), result('js/request-forgery', 'src/b.ts', 3, 'h2:1')];
  const log = sarif(results);

  it('writes the baseline a scan holds, which then passes the same scan and is unchanged by regenerating it', () => {
    const root = temp();
    const file = join(root, 'scan.sarif');
    writeFileSync(file, JSON.stringify(log));
    const wrote = capture();
    assert.equal(runCodeqlBaseline({ mode: 'write', sarif: file, root, baseline: BASELINE_PATH }, wrote.io.out), 0);
    assert.deepEqual(wrote.out, [`Wrote 3 alert(s) to ${BASELINE_PATH}`]);
    const written = readFileSync(join(root, BASELINE_PATH), 'utf8');
    assert.equal(written, `${JSON.stringify(toBaseline(readBaseline(root)), null, 2)}\n`);
    const checked = capture();
    assert.equal(runCodeqlBaseline({ mode: 'check', sarif: file, root, baseline: BASELINE_PATH }, checked.io.out), 0);
    assert.deepEqual(checked.out, ['CodeQL: 3 error-level alert(s), 3 in the baseline']);
    assert.equal(runCodeqlBaseline({ mode: 'write', sarif: file, root, baseline: BASELINE_PATH }, capture().io.out), 0);
    assert.equal(readFileSync(join(root, BASELINE_PATH), 'utf8'), written);
  });

  it('fails a scan with an alert the baseline does not hold, naming it', () => {
    const root = temp();
    const file = join(root, 'scan.sarif');
    writeFileSync(join(root, 'baseline.json'), JSON.stringify(toBaseline(errorAlerts(log))));
    writeFileSync(file, JSON.stringify(sarif([...results, result('js/sql-injection', 'src/db.ts', 9, 'h3:1', 'error')])));
    const c = capture();
    assert.equal(runCodeqlBaseline({ mode: 'check', sarif: file, root, baseline: join(root, 'baseline.json') }, c.io.out), 1);
    assert.deepEqual(c.out, ['CodeQL: 4 error-level alert(s), 3 in the baseline', 'CodeQL: 1 new error-level alert(s):', '  js/sql-injection  src/db.ts:9  js/sql-injection message']);
  });

  it('throws, naming the file, on a SARIF log it cannot read, a baseline it cannot read, or a scan it cannot write from', () => {
    const root = temp();
    const out = capture();
    assert.throws(() => runCodeqlBaseline({ mode: 'check', sarif: join(root, 'none.sarif'), root, baseline: BASELINE_PATH }, out.io.out), /^Error: cannot read the SARIF log .*none\.sarif: ENOENT/);
    const file = join(root, 'scan.sarif');
    writeFileSync(file, JSON.stringify(log));
    assert.throws(() => runCodeqlBaseline({ mode: 'check', sarif: file, root, baseline: join(root, 'none.json') }, out.io.out), /^Error: cannot read the baseline none\.json: ENOENT/);
    writeFileSync(join(root, 'empty.sarif'), '{"runs": []}');
    assert.throws(() => runCodeqlBaseline({ mode: 'write', sarif: join(root, 'empty.sarif'), root, baseline: 'b.json' }, out.io.out), {
      message: 'no baseline was written to b.json: CodeQL SARIF has no runs; the analysis output is unusable',
    });
    assert.deepEqual(out.out, []);
  });

  it('fails, not throws, a check of a log with no runs', () => {
    const root = temp();
    writeFileSync(join(root, 'b.json'), JSON.stringify(toBaseline([])));
    writeFileSync(join(root, 'empty.sarif'), '{"runs": []}');
    const c = capture();
    assert.equal(runCodeqlBaseline({ mode: 'check', sarif: join(root, 'empty.sarif'), root, baseline: 'b.json' }, c.io.out), 1);
    assert.deepEqual(c.out, ['CodeQL: CodeQL SARIF has no runs; the analysis output is unusable']);
  });
});
