import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { CASES, EXTRAS, NO_HASH_LANGUAGES } from './markdownlint-rules.cases.test.ts';
import rulesDefault, { DEFAULT_OPTIONS, listOption, proseLines, readConfig, RULES, TAG, walk, type MarkdownRule, type RuleParams, type Token } from './markdownlint-rules.ts';

// markdownlint is not a dependency, so the rules run on micromark-shaped tokens
// built here: the token types the rules read (paragraph, codeText, codeFenced
// with its fences, info and values, codeIndented, htmlFlow), with markdownlint's
// 1-based lines and columns and exclusive end columns. A run of real
// markdownlint over the same texts is the check on this builder.

interface Built {
  type: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
  children: Built[];
}

const slice = (lines: readonly string[], sl: number, sc: number, el: number, ec: number): string =>
  sl === el ? (lines[sl - 1] ?? '').slice(sc - 1, ec - 1) : [(lines[sl - 1] ?? '').slice(sc - 1), ...lines.slice(sl, el - 1), (lines[el - 1] ?? '').slice(0, ec - 1)].join('\n');

const tok = (type: string, lines: readonly string[], sl: number, sc: number, el: number, ec: number, children: Built[] = []): Built => ({
  type,
  startLine: sl,
  startColumn: sc,
  endLine: el,
  endColumn: ec,
  text: slice(lines, sl, sc, el, ec),
  children,
});

/** The code spans in a region, as CommonMark pairs backtick runs of equal length. */
const codeSpans = (lines: readonly string[], sl: number, sc: number, el: number, ec: number): Built[] => {
  const src = slice(lines, sl, sc, el, ec);
  const at = (o: number): [number, number] => {
    const before = src.slice(0, o);
    const nl = before.lastIndexOf('\n');
    return [sl + before.split('\n').length - 1, nl === -1 ? sc + o : o - nl];
  };
  const run = (o: number): number => {
    let n = 0;
    while (src[o + n] === '`') n += 1;
    return n;
  };
  const spans: Built[] = [];
  let k = 0;
  while (k < src.length) {
    if (src[k] === '\\') k += 2;
    else if (src[k] !== '`') k += 1;
    else {
      const n = run(k);
      let m = k + n;
      let close = -1;
      while (m < src.length && close === -1) {
        if (src[m] !== '`') m += 1;
        else if (run(m) === n) close = m;
        else m += run(m);
      }
      if (close === -1) k += n;
      else {
        const [l1, c1] = at(k);
        const [l2, c2] = at(close + n);
        spans.push(tok('codeText', lines, l1, c1, l2, c2));
        k = close + n;
      }
    }
  }
  return spans;
};

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}#{1,6}(\s|$)/;
const HTML = /^ {0,3}<[A-Za-z/!?]/;
const INDENTED = /^( {4}|\t)/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const CONTAINER = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?/;

const fenceOpen = (line: string): RegExpExecArray | null => {
  const m = FENCE_OPEN.exec(line);
  return m !== null && !((m[2] ?? '').startsWith('`') && (m[3] ?? '').includes('`')) ? m : null;
};

/** `text` as markdownlint passes it to a micromark rule: its lines and its block tokens. */
const tokenize = (text: string): { lines: string[]; tokens: Built[] } => {
  const lines = text.split(/\r\n|\r|\n/);
  const end = (n: number): number => (lines[n - 1] ?? '').length + 1;
  const tokens: Built[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const n = i + 1;
    const fence = fenceOpen(line);
    if (line.trim() === '') i += 1;
    else if (fence !== null) {
      const indent = (fence[1] ?? '').length;
      const marker = fence[2] ?? '';
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j] ?? '')) j += 1;
      const closed = j < lines.length;
      const info = (fence[3] ?? '').trim().split(/\s+/)[0] ?? '';
      const infoColumn = line.indexOf(info, indent + marker.length) + 1;
      const children = [tok('codeFencedFence', lines, n, indent + 1, n, end(n), info === '' ? [] : [tok('codeFencedFenceInfo', lines, n, infoColumn, n, infoColumn + info.length)])];
      for (let k = i + 1; k < j; k += 1) {
        const body = lines[k] ?? '';
        const lead = Math.min(indent, body.length - body.trimStart().length);
        if (body.length > lead) children.push(tok('codeFlowValue', lines, k + 1, lead + 1, k + 1, end(k + 1)));
      }
      if (closed) children.push(tok('codeFencedFence', lines, j + 1, 1, j + 1, end(j + 1)));
      const last = closed ? j + 1 : lines.length;
      tokens.push(tok('codeFenced', lines, n, indent + 1, last, end(last), children));
      i = last;
    } else if (ATX.test(line)) {
      tokens.push(tok('atxHeading', lines, n, 1, n, end(n), codeSpans(lines, n, 1, n, end(n))));
      i += 1;
    } else if (HTML.test(line)) {
      let j = i;
      while (j < lines.length && (lines[j] ?? '').trim() !== '') j += 1;
      tokens.push(tok('htmlFlow', lines, n, 1, j, end(j)));
      i = j;
    } else if (INDENTED.test(line)) {
      let j = i;
      while (j < lines.length && (INDENTED.test(lines[j] ?? '') || (lines[j] ?? '').trim() === '')) j += 1;
      while ((lines[j - 1] ?? '').trim() === '') j -= 1;
      tokens.push(tok('codeIndented', lines, n, 1, j, end(j)));
      i = j;
    } else if (line.includes('|') && DELIMITER.test(lines[i + 1] ?? '')) {
      let j = i;
      while (j < lines.length && (lines[j] ?? '').trim() !== '') j += 1;
      const rows: Built[] = [];
      for (let k = i; k < j; k += 1) rows.push(tok('tableRow', lines, k + 1, 1, k + 1, end(k + 1), codeSpans(lines, k + 1, 1, k + 1, end(k + 1))));
      tokens.push(tok('table', lines, n, 1, j, end(j), rows));
      i = j;
    } else {
      let j = i + 1;
      const continues = (next: string): boolean => next.trim() !== '' && fenceOpen(next) === null && !ATX.test(next) && !LIST_ITEM.test(next);
      while (j < lines.length && continues(lines[j] ?? '')) j += 1;
      const start = (CONTAINER.exec(line)?.[0].length ?? 0) + 1;
      tokens.push(tok('paragraph', lines, n, start, j, end(j), codeSpans(lines, n, start, j, end(j))));
      i = j;
    }
  }
  return { lines, tokens };
};

const BASE: Record<string, unknown> = { default: false, [TAG]: true };

/** A rule's configuration as markdownlint derives it: the last key naming the rule or its tag wins, `enabled` and `severity` stripped. */
const ruleConfig = (rule: MarkdownRule, config: Record<string, unknown>): Record<string, unknown> | false => {
  let enabled = config['default'] === undefined ? true : Boolean(config['default']);
  let value: Record<string, unknown> = {};
  const names = [...rule.names, ...rule.tags].map((name) => name.toUpperCase());
  for (const [key, v] of Object.entries(config)) {
    if (key.toUpperCase() === 'DEFAULT' || !names.includes(key.toUpperCase())) continue;
    if (v !== null && typeof v === 'object') {
      const { enabled: on, severity: _severity, ...rest } = v as Record<string, unknown>;
      enabled = on === undefined ? true : Boolean(on);
      value = rest;
    } else {
      enabled = Boolean(v);
      value = {};
    }
  }
  return enabled ? value : false;
};

interface Found {
  readonly rule: string;
  readonly line: number;
  readonly detail: string;
}

/** Every finding the rules report in `text`, in markdownlint's order (rule name, then line). */
const lint = (text: string, config: Record<string, unknown> = BASE): Found[] => {
  const { lines, tokens } = tokenize(text);
  const found: Array<Found & { name: string }> = [];
  for (const rule of RULES) {
    const c = ruleConfig(rule, config);
    if (c === false) continue;
    const name = rule.names[0] ?? '';
    rule.function({ lines, parsers: { micromark: { tokens } }, config: c }, (e) =>
      found.push({ name, rule: name.replace(/^pariksha-/, ''), line: e.lineNumber, detail: e.detail ?? rule.description }),
    );
  }
  found.sort((a, b) => a.name.localeCompare(b.name) || a.line - b.line);
  return found.map(({ rule, line, detail }) => ({ rule, line, detail }));
};

const findings = (text: string, config: Record<string, unknown> = BASE): string[] => lint(text, config).map((f) => `${f.rule}@${f.line}`);
const off = (rule: string): Record<string, unknown> => ({ ...BASE, [`pariksha-${rule}`]: false });

describe('the rules', () => {
  it('carry the tag, the micromark parser and a pariksha- name, and each has a case', () => {
    assert.equal(RULES.length, 12);
    assert.equal(rulesDefault, RULES);
    assert.equal(new Set(RULES.map((r) => r.names[0])).size, RULES.length);
    for (const rule of RULES) {
      assert.deepEqual(rule.tags, [TAG]);
      assert.equal(rule.parser, 'micromark');
      assert.match(rule.names[0] ?? '', /^pariksha-[a-z-]+$/);
      assert.ok(
        CASES.some((c) => `pariksha-${c.rule}` === rule.names[0]),
        `${rule.names[0]} has no case`,
      );
    }
    assert.equal(TAG, 'pariksha-markdown');
  });

  for (const [index, c] of CASES.entries()) {
    describe(`${c.rule} (case ${index + 1})`, () => {
      it('fails the example on its line', () => {
        const found = lint(c.example);
        assert.deepEqual(
          found.map((f) => `${f.rule}@${f.line}`),
          [`${c.rule}@${c.line}`],
        );
        assert.equal(found[0]?.detail, c.detail);
      });

      it('passes the corrected text', () => {
        assert.deepEqual(findings(c.corrected), []);
      });

      for (const text of c.nearMisses) {
        it(`passes the near miss ${JSON.stringify(text)}`, () => {
          assert.deepEqual(findings(text), []);
        });
      }

      it('lets the example through with the rule switched off', () => {
        assert.deepEqual(findings(c.example, off(c.rule)), []);
      });
    });
  }

  for (const extra of EXTRAS.filter((e) => e.engineOnly !== true)) {
    it(extra.name, () => {
      assert.deepEqual(findings(extra.text), extra.findings);
    });
  }

  it('reads every line markdownlint passes, CRLF ones too', () => {
    assert.deepEqual(findings('Text.\r\n\r\n> [!NOTE] > body\r\n'), ['alert-marker-inline@3']);
    assert.deepEqual(findings('<div>\n**DEV**\n</div>\n'), []);
    assert.deepEqual(findings('Text.\n\n    **DEV** in code\n'), []);
  });
});

describe('options', () => {
  const tagged = (options: Record<string, unknown>): Record<string, unknown> => ({ default: false, [TAG]: options });

  it('default to the lists the rules were written for', () => {
    assert.deepEqual(DEFAULT_OPTIONS.dunder_words, ['DEV', 'proto', 'esModule', 'typename']);
    assert.deepEqual(DEFAULT_OPTIONS.no_hash_languages, NO_HASH_LANGUAGES);
    assert.deepEqual(DEFAULT_OPTIONS.alert_types, ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']);
    for (const name of Object.keys(DEFAULT_OPTIONS) as Array<keyof typeof DEFAULT_OPTIONS>) {
      assert.equal(listOption('pariksha-x', undefined, name), DEFAULT_OPTIONS[name]);
      assert.equal(listOption('pariksha-x', {}, name), DEFAULT_OPTIONS[name]);
    }
  });

  it('dunder_words replaces the dunder names, matched literally', () => {
    assert.deepEqual(findings('**foo** and **DEV**\n', tagged({ dunder_words: ['foo'] })), ['dunder-mangle@1']);
    assert.equal(lint('**foo**\n', tagged({ dunder_words: ['foo'] }))[0]?.detail, 'renders as bold "foo"; the identifier is `__foo__` in a code span');
    assert.deepEqual(findings('**a$b** **aXb**\n', tagged({ dunder_words: ['a$b'] })), ['dunder-mangle@1']);
  });

  it('no_hash_languages replaces the fence languages, compared case-insensitively', () => {
    const bash = '```bash\n# Heading\n```\n';
    const typescript = '```ts\n# Heading\n```\n';
    assert.deepEqual(findings(bash, tagged({ no_hash_languages: ['BASH'] })), ['fence-swallows-heading@2']);
    assert.deepEqual(findings(typescript, tagged({ no_hash_languages: ['bash'] })), []);
  });

  it('alert_types replaces the alert types, still case-insensitive', () => {
    assert.deepEqual(findings('> [!TIP] > body\n', tagged({ alert_types: ['NOTE'] })), []);
    assert.deepEqual(findings('> [!note] > body\n', tagged({ alert_types: ['NOTE'] })), ['alert-marker-inline@1']);
    assert.deepEqual(findings('> [!DANGER] > body\n', tagged({ alert_types: ['DANGER'] })), ['alert-marker-inline@1']);
  });

  it('link_target_extensions replaces the file extensions; URLs, paths and anchors still count', () => {
    const ext = tagged({ link_target_extensions: ['txt'] });
    assert.deepEqual(findings('[a] (notes.txt)\n', ext), ['link-space-before-paren@1']);
    assert.deepEqual(findings('[a] (notes.md)\n', ext), []);
    assert.deepEqual(findings('[a] (notes.md)\n'), ['link-space-before-paren@1']);
    assert.deepEqual(findings('[a] (./notes.md) [b] (#top) [c] (https://x.test)\n', ext), ['link-space-before-paren@1', 'link-space-before-paren@1', 'link-space-before-paren@1']);
  });

  it('set under the tag reach every rule; set under a rule name, they replace the tag object for it', () => {
    const both = { ...tagged({ dunder_words: ['foo'], no_hash_languages: ['bash'] }) };
    assert.deepEqual(findings('**foo**\n\n```bash\n# Heading\n```\n', both), ['dunder-mangle@1', 'fence-swallows-heading@4']);
    const replaced = { ...both, 'pariksha-dunder-mangle': {} };
    assert.deepEqual(findings('**foo** **DEV**\n', replaced), ['dunder-mangle@1']);
    assert.equal(lint('**foo** **DEV**\n', replaced)[0]?.detail, 'renders as bold "DEV"; the identifier is `__DEV__` in a code span');
  });
});

describe('refused configuration', () => {
  const run = (rule: string, config: unknown) => () => {
    const found = RULES.find((r) => r.names[0] === `pariksha-${rule}`);
    assert.ok(found);
    found.function({ lines: ['text'], parsers: { micromark: { tokens: [] } }, config }, () => undefined);
  };

  it('every rule refuses an option no rule reads, and accepts the others’ options', () => {
    for (const rule of RULES) {
      const name = (rule.names[0] ?? '').replace(/^pariksha-/, '');
      assert.throws(run(name, { dunder_word: ['DEV'] }), new RegExp(`^Error: ${rule.names[0]}: unknown option "dunder_word"; the options are alert_types, link_target_extensions, dunder_words, no_hash_languages$`));
      assert.doesNotThrow(run(name, { ...DEFAULT_OPTIONS }));
    }
  });

  it('refuses a configuration that is not an object', () => {
    for (const config of [[], null, 'x', 42]) {
      assert.throws(run('fence-empty', config), /^Error: pariksha-fence-empty: its configuration must be true, false or an object of options; got /);
    }
    assert.throws(run('fence-empty', []), /got an array$/);
    assert.throws(run('fence-empty', null), /got null$/);
    assert.throws(run('fence-empty', 'x'), /got "x"$/);
    assert.throws(run('fence-empty', 42), /got a number$/);
  });

  it('refuses a list option that is not a non-empty array of strings', () => {
    assert.throws(run('dunder-mangle', { dunder_words: 'DEV' }), /^Error: pariksha-dunder-mangle: option "dunder_words" must be a non-empty array of strings \(to turn the rule off, set it to false\); got "DEV"$/);
    assert.throws(run('dunder-mangle', { dunder_words: [] }), /got an array$/);
    assert.throws(run('alert-marker-inline', { alert_types: { NOTE: true } }), /option "alert_types" must be a non-empty array of strings .*; got an object$/);
    assert.throws(run('fence-swallows-heading', { no_hash_languages: ['ts', 1] }), /^Error: pariksha-fence-swallows-heading: option "no_hash_languages" holds a number; each entry must be a string of no whitespace$/);
  });

  it('refuses entries of the wrong shape, which could never match', () => {
    assert.throws(run('dunder-mangle', { dunder_words: ['__DEV__'] }), /holds "__DEV__"; each entry must be a string of an identifier without its surrounding underscores$/);
    assert.throws(run('dunder-mangle', { dunder_words: [''] }), /holds ""/);
    assert.throws(run('fence-swallows-heading', { no_hash_languages: ['type script'] }), /holds "type script"/);
    assert.throws(run('link-space-before-paren', { link_target_extensions: ['.md'] }), /holds "\.md"; each entry must be a string of letters and digits, without the dot$/);
    assert.throws(run('alert-marker-inline', { alert_types: ['NO-TE'] }), /holds "NO-TE"; each entry must be a string of letters only$/);
  });

  it('fails the lint run when configured under the tag, rather than ignoring the option', () => {
    assert.throws(() => lint('text\n', { default: false, [TAG]: { dunder_words: 'DEV' } }), /pariksha-dunder-mangle: option "dunder_words"/);
  });

  it('reads an absent configuration as no options', () => {
    assert.deepEqual(readConfig('pariksha-x', undefined), {});
    assert.throws(() => readConfig('pariksha-x', { nope: 1 }), /unknown option "nope"/);
  });
});

describe('proseLines', () => {
  const params = (lines: string[], tokens: readonly Token[]): RuleParams => ({ lines, parsers: { micromark: { tokens } } });
  const token = (type: string, startLine: number, startColumn: number, endLine: number, endColumn: number, children: Token[] = []): Token => ({
    type,
    startLine,
    startColumn,
    endLine,
    endColumn,
    text: '',
    children,
  });

  it('nulls code and HTML block lines and blanks code spans', () => {
    const lines = ['a `b` c', '```', 'x', '```', '<div>', 'd `e', 'f` g', '    code'];
    const result = proseLines(
      params(lines, [
        token('paragraph', 1, 1, 1, 8, [token('codeText', 1, 3, 1, 6)]),
        token('codeFenced', 2, 1, 4, 4),
        token('htmlFlow', 5, 1, 5, 6),
        token('paragraph', 6, 1, 7, 5, [token('codeText', 6, 3, 7, 3)]),
        token('codeIndented', 8, 1, 8, 9),
      ]),
    );
    assert.deepEqual(result, ['a     c', null, null, null, null, 'd   ', '   g', null]);
  });

  it('builds the same tokens by hand and from text', () => {
    const { lines, tokens } = tokenize('a `b` c\n```\nx\n```\n<div>\n\nd `e\nf` g\n\n    code');
    assert.deepEqual(proseLines(params(lines, tokens)), ['a     c', null, null, null, null, '', 'd   ', '   g', '', null]);
  });

  it('walks tokens depth first', () => {
    const tree = [token('a', 1, 1, 1, 1, [token('b', 1, 1, 1, 1)]), token('c', 1, 1, 1, 1)];
    assert.deepEqual(
      walk(tree).map((t) => t.type),
      ['a', 'b', 'c'],
    );
  });

  it('takes a fence with no opening fence token as no language', () => {
    const fenced = token('codeFenced', 1, 1, 2, 1, [token('codeFlowValue', 2, 1, 2, 10)]);
    const rule = RULES.find((r) => r.names[0] === 'pariksha-fence-swallows-heading');
    const found: number[] = [];
    rule?.function({ ...params(['```', '# Heading'], [fenced]), config: {} }, (e) => found.push(e.lineNumber));
    assert.deepEqual(found, []);
  });
});

describe('the ./markdownlint export', () => {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name: string; exports: Record<string, string>; bin: Record<string, string> };

  it('keeps the bin and package.json, and maps ./markdownlint to the built rules', () => {
    assert.deepEqual(pkg.bin, { pariksha: 'dist/cli.js' });
    assert.equal(pkg.exports['./markdownlint'], './dist/markdownlint-rules.js');
    assert.equal(pkg.exports['./package.json'], './package.json');
    assert.equal(pkg.exports['./dist/*'], './dist/*');
  });

  it('loads in a consumer as markdownlint-cli2 loads it, and by a bare require', () => {
    // The package as a consumer installs it: its package.json and the rules
    // module compiled as the build compiles it.
    const consumer = mkdtempSync(join(tmpdir(), 'pariksha-markdownlint-'));
    const installed = join(consumer, 'node_modules', pkg.name);
    mkdirSync(join(installed, 'dist'), { recursive: true });
    writeFileSync(join(consumer, 'package.json'), '{"name":"consumer","private":true}');
    writeFileSync(join(installed, 'package.json'), JSON.stringify(pkg));
    const source = readFileSync(join(pkgDir, 'src', 'markdownlint-rules.ts'), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true } }).outputText;
    writeFileSync(join(installed, 'dist', 'markdownlint-rules.js'), js);
    // markdownlint-cli2: resolve the id with require.resolve from the config's
    // folder, then import() the file and take its default export.
    const probe = [
      "import { createRequire } from 'node:module';",
      "import { pathToFileURL } from 'node:url';",
      `const id = '${pkg.name}/markdownlint';`,
      "const req = createRequire(process.cwd() + '/');",
      'const resolved = req.resolve(id, { paths: [process.cwd()] });',
      'const imported = (await import(pathToFileURL(resolved).href)).default;',
      'const required = req(id);',
      'console.log(JSON.stringify({ resolved, isArray: Array.isArray(required), same: required === imported, names: imported.map((r) => r.names[0]), tags: [...new Set(imported.flatMap((r) => r.tags))] }));',
    ].join('\n');
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: consumer, encoding: 'utf8' })) as {
      resolved: string;
      isArray: boolean;
      same: boolean;
      names: string[];
      tags: string[];
    };
    assert.ok(out.resolved.endsWith(join('node_modules', '@veda-hq', 'pariksha', 'dist', 'markdownlint-rules.js')));
    assert.equal(out.isArray, true);
    assert.equal(out.same, true);
    assert.deepEqual(
      out.names,
      RULES.map((r) => r.names[0]),
    );
    assert.deepEqual(out.tags, [TAG]);
  });
});
