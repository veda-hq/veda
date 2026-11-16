// The byte and line rules of repo-rules, each first on its lesson's own incident.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeqlSuppressionCommentForm, DEFAULT_MAX_LINE_BYTES, longLineNotRgignored, longLineOf, rawNulInSource, rgIgnored, suppressionProblem } from './repo-rules-files.ts';
import { memoryRepo } from './repo-rules-memory.ts';

describe('longLineOf', () => {
  it('finds the first line over the limit, the last line included', () => {
    assert.deepEqual(longLineOf(Buffer.from('ab\nabcdef\nabc'), 3), { line: 2, length: 6 });
    assert.deepEqual(longLineOf(Buffer.from('ab\nabcdef'), 3), { line: 2, length: 6 });
    assert.equal(longLineOf(Buffer.from('abc\nabc\n'), 3), undefined);
    assert.equal(DEFAULT_MAX_LINE_BYTES, 1_000_000);
  });
});

describe('long-line-not-rgignored', () => {
  /** A repo whose git answers `ls-files --ignored` with `ignored`, recording the call. */
  const repoWith = (files: Record<string, string>, ignored: string[] | undefined, calls: string[][] = []) =>
    memoryRepo(files, {
      run: (args) => {
        calls.push([...args]);
        return ignored === undefined ? undefined : ignored.map((p) => `${p}\0`).join('');
      },
    });

  it('refuses the incident: a one-line generated page that made the review request 413', () => {
    const calls: string[][] = [];
    const repo = repoWith({ 'docs/report.html': `<p>\n${'x'.repeat(12)}\n`, 'docs/ok.json': 'x'.repeat(12), 'small.txt': 'ab' }, ['docs/ok.json'], calls);
    assert.deepEqual(longLineNotRgignored.run(repo, { maxLineBytes: 10 }), [{ file: 'docs/report.html', line: 2, detail: 'a 12-byte line, and no .rgignore entry covers the file' }]);
    assert.deepEqual(calls, [['ls-files', '-z', '--cached', '--ignored', '--exclude-standard', '--', ':(literal)docs/ok.json', ':(literal)docs/report.html']]);
  });

  it('reads the root .rgignore and .ignore when they exist, and asks git nothing when no line is long', () => {
    const calls: string[][] = [];
    const repo = repoWith({ '.rgignore': 'big.json\n', '.ignore': '', 'big.json': 'x'.repeat(12) }, [], calls);
    assert.deepEqual(rgIgnored(repo, ['big.json']), new Set());
    assert.deepEqual(calls[0]?.slice(5, 7), ['--exclude-from=/memory/.rgignore', '--exclude-from=/memory/.ignore']);
    const quiet: string[][] = [];
    assert.deepEqual(longLineNotRgignored.run(repoWith({ 'a.txt': 'short' }, [], quiet), {}), []);
    assert.deepEqual(quiet, []);
  });

  it('stops when git cannot list the ignored files, and validates its setting', () => {
    assert.throws(() => longLineNotRgignored.run(repoWith({ 'a.json': 'x'.repeat(12) }, undefined), { maxLineBytes: 10 }), /git ls-files --ignored failed/);
    assert.equal(longLineNotRgignored.settings?.['maxLineBytes']?.(5), undefined);
    assert.match(longLineNotRgignored.settings?.['maxLineBytes']?.(0) ?? '', /positive whole number/);
    assert.match(longLineNotRgignored.settings?.['maxLineBytes']?.(1.5) ?? '', /positive whole number/);
  });

  it('skips a selected file that is gone', () => {
    assert.deepEqual(longLineNotRgignored.run(memoryRepo({}, { selected: ['gone.json'] }), {}), []);
  });
});

describe('raw-nul-in-source', () => {
  it('refuses the incident: a NUL separator written raw, so the diff read "Bin"', () => {
    const repo = memoryRepo({ 'src/split.ts': Buffer.from("export const a = 1;\nconst SEP = '\0';\n"), 'img.png': Buffer.from([0, 1, 2]), 'src/ok.ts': "const SEP = '\\0';\n" });
    assert.deepEqual(rawNulInSource.run(repo, {}), [{ file: 'src/split.ts', line: 2, detail: 'a raw NUL byte, so git shows the file as binary' }]);
  });

  it('reads the extensions setting, case-blind, and skips files with none or that are gone', () => {
    const repo = memoryRepo({ 'data.BIN': Buffer.from([0]), Makefile: Buffer.from([0]) });
    assert.deepEqual(rawNulInSource.run(repo, {}), []);
    assert.deepEqual(
      rawNulInSource.run(repo, { extensions: ['.bin'] }).map((f) => f.file),
      ['data.BIN'],
    );
    assert.deepEqual(rawNulInSource.run(memoryRepo({}, { selected: ['gone.ts'] }), {}), []);
  });
});

describe('codeql-suppression-comment-form', () => {
  it('reads what is wrong with one line', () => {
    assert.equal(suppressionProblem('// codeql[js/request-forgery]'), undefined);
    assert.equal(suppressionProblem('  # codeql[py/x] codeql[py/y]'), undefined);
    assert.match(suppressionProblem('// codeql[js/a, js/b]') ?? '', /several queries/);
    assert.match(suppressionProblem('fetch(url); // codeql[js/request-forgery]') ?? '', /shares its line with code/);
    assert.match(suppressionProblem('{/* codeql[js/xss] */}') ?? '', /shares its line with code/);
    assert.equal(suppressionProblem("const s = '// codeql[js/a, js/b]';"), undefined);
    assert.equal(suppressionProblem('codeql[js/a] in prose'), undefined);
    assert.equal(suppressionProblem('plain code'), undefined);
  });

  it('refuses the incident: a comma list and a trailing comment, which CodeQL both ignored', () => {
    const repo = memoryRepo({
      'src/a.ts': '// codeql[js/a, js/b]\nfetch(x); // codeql[js/request-forgery]\n// codeql[js/c]\nfetch(y);\n',
      'src/b.ts': 'no suppression here',
      'README.md': 'fetch(x); // codeql[js/a]',
    });
    assert.deepEqual(codeqlSuppressionCommentForm.run(repo, {}), [
      { file: 'src/a.ts', line: 1, detail: 'the suppression comment names several queries in one codeql[...]; write codeql[a] codeql[b]' },
      { file: 'src/a.ts', line: 2, detail: 'the suppression comment shares its line with code, so CodeQL ignores it; put it alone on the line above the alert' },
    ]);
    assert.deepEqual(codeqlSuppressionCommentForm.run(memoryRepo({}, { selected: ['gone.ts'] }), {}), []);
  });
});
