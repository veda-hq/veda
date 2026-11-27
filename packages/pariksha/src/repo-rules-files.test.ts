// The byte and line rules of repo-rules, each first on its lesson's own incident.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeqlSuppressionCommentForm, DEFAULT_MAX_LINE_BYTES, FILE_RULES, longLineNotRgignored, longLineOf, rawNulInSource, rgIgnored, suppressionProblem } from './repo-rules-files.ts';
import { memoryRepo } from './repo-rules-memory.ts';

describe('the file rules', () => {
  it('lists the three rules, in order', () => {
    assert.deepEqual(
      FILE_RULES.map((rule) => rule.id),
      ['long-line-not-rgignored', 'raw-nul-in-source', 'codeql-suppression-comment-form'],
    );
  });

  it('gives each rule its id and lesson', () => {
    assert.equal(longLineNotRgignored.id, 'long-line-not-rgignored');
    assert.equal(
      longLineNotRgignored.lesson,
      'A review bot that greps the tree (Cubic) gets whole lines back, so one tracked file with a multi-MB line (generated HTML or JSON) makes its request fail with "413 Request Entity Too Large", at random, whatever the diff\'s size. List the file in the root `.rgignore`, instead of splitting commits.',
    );
    assert.equal(rawNulInSource.id, 'raw-nul-in-source');
    assert.equal(
      rawNulInSource.lesson,
      'A raw NUL byte in a source file makes git treat the file as binary: its diff shows "Bin N -> M bytes", so the change is invisible to review and blame while tsc, lint and tests pass. Write a NUL separator as the `\\0` or `\\x00` escape.',
    );
    assert.equal(codeqlSuppressionCommentForm.id, 'codeql-suppression-comment-form');
    assert.equal(
      codeqlSuppressionCommentForm.lesson,
      "A `// codeql[rule-id]` comment suppresses an alert only alone on its line, directly above the alert's start line (JSX `{/* */}` is ignored), one query per brackets: `codeql[a] codeql[b]`, not a comma list. It also does nothing unless `AlertSuppression.ql` runs with the suite; `security-and-quality` omits it, so add it through `packs:`.",
    );
  });
});

describe('longLineOf', () => {
  it('finds the first line over the limit, the last line included', () => {
    assert.deepEqual(longLineOf(Buffer.from('ab\nabcdef\nabc'), 3), { line: 2, length: 6 });
    assert.deepEqual(longLineOf(Buffer.from('ab\nabcdef'), 3), { line: 2, length: 6 });
    assert.deepEqual(longLineOf(Buffer.from('abcd\nabcdef'), 3), { line: 1, length: 4 });
    assert.equal(longLineOf(Buffer.from('abc\nabc\n'), 3), undefined);
    assert.equal(longLineOf(Buffer.from('abc\nabc'), 3), undefined);
    assert.equal(DEFAULT_MAX_LINE_BYTES, 1_000_000);
  });

  it('counts bytes, not characters', () => {
    // 'é' is two bytes in UTF-8, so 'éé' is a 4-byte line.
    assert.deepEqual(longLineOf(Buffer.from('a\néé\n', 'utf8'), 3), { line: 2, length: 4 });
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

  it('reads the bytes only of files over the limit, and reports only a line over it', () => {
    const read: string[] = [];
    const base = repoWith({ 'at-limit.txt': 'x'.repeat(10), 'short-lines.txt': 'abcde\nabcde\nabcde\n', 'long.txt': 'x'.repeat(11) }, []);
    const repo = {
      ...base,
      bytes: (path: string) => {
        read.push(path);
        return base.bytes(path);
      },
    };
    assert.deepEqual(longLineNotRgignored.run(repo, { maxLineBytes: 10 }), [{ file: 'long.txt', line: 1, detail: 'a 11-byte line, and no .rgignore entry covers the file' }]);
    assert.deepEqual(read, ['long.txt', 'short-lines.txt']);
  });

  it('skips a file whose bytes are gone after its size was read', () => {
    const repo = { ...repoWith({ 'a.json': 'x'.repeat(12) }, undefined), bytes: () => undefined };
    assert.deepEqual(longLineNotRgignored.run(repo, { maxLineBytes: 10 }), []);
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

  it('reads only the last extension of a name', () => {
    const repo = memoryRepo({ 'types/lib.d.ts': Buffer.from([0]), 'src/x.ts.orig': Buffer.from([0]) });
    assert.deepEqual(rawNulInSource.run(repo, {}), [{ file: 'types/lib.d.ts', line: 1, detail: 'a raw NUL byte, so git shows the file as binary' }]);
  });

  it('reads a name with no extension as the extension ""', () => {
    const repo = memoryRepo({ Makefile: Buffer.from([0]), 'a.ts': Buffer.from([0]) });
    assert.deepEqual(rawNulInSource.run(repo, { extensions: [''] }), [{ file: 'Makefile', line: 1, detail: 'a raw NUL byte, so git shows the file as binary' }]);
  });

  it('validates its extensions setting', () => {
    assert.equal(rawNulInSource.settings?.['extensions']?.(['.bin']), undefined);
    assert.equal(rawNulInSource.settings?.['extensions']?.([]), 'must be a non-empty list of strings');
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

  it('reads a comment with no space before codeql[, and judges only the text from the comment on', () => {
    const shares = 'shares its line with code, so CodeQL ignores it; put it alone on the line above the alert';
    assert.equal(suppressionProblem('fetch(url); //codeql[js/request-forgery]'), shares);
    assert.equal(suppressionProblem('#codeql[py/a, py/b]'), 'names several queries in one codeql[...]; write codeql[a] codeql[b]');
    assert.equal(suppressionProblem('codeql[a, b]; // codeql[js/x]'), shares);
  });

  it('reads every source CodeQL reads suppressions in, and no other', () => {
    const files = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.java', '.kt', '.cs', '.swift', '.c', '.h', '.cc', '.cpp', '.vue', '.html', '.md', '.sh'].map((ext) => `src/a${ext}`);
    const repo = memoryRepo(Object.fromEntries(files.map((file) => [file, 'x(); // codeql[a]'])));
    const detail = 'the suppression comment shares its line with code, so CodeQL ignores it; put it alone on the line above the alert';
    assert.deepEqual(codeqlSuppressionCommentForm.run(repo, {}), [
      { file: 'src/a.c', line: 1, detail },
      { file: 'src/a.cc', line: 1, detail },
      { file: 'src/a.cjs', line: 1, detail },
      { file: 'src/a.cpp', line: 1, detail },
      { file: 'src/a.cs', line: 1, detail },
      { file: 'src/a.cts', line: 1, detail },
      { file: 'src/a.go', line: 1, detail },
      { file: 'src/a.h', line: 1, detail },
      { file: 'src/a.html', line: 1, detail },
      { file: 'src/a.java', line: 1, detail },
      { file: 'src/a.js', line: 1, detail },
      { file: 'src/a.jsx', line: 1, detail },
      { file: 'src/a.kt', line: 1, detail },
      { file: 'src/a.mjs', line: 1, detail },
      { file: 'src/a.mts', line: 1, detail },
      { file: 'src/a.py', line: 1, detail },
      { file: 'src/a.rb', line: 1, detail },
      { file: 'src/a.swift', line: 1, detail },
      { file: 'src/a.ts', line: 1, detail },
      { file: 'src/a.tsx', line: 1, detail },
      { file: 'src/a.vue', line: 1, detail },
    ]);
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
