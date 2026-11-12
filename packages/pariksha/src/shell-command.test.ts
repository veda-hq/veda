/**
 * shell-command.ts: the reading masked-exit-codes splits scripts with. Ported
 * case for case from the original's suite for the functions carried over;
 * its heredoc cases, which asked whether a command line survived, ask it of
 * `stripHeredocBodies` directly.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitAndOrLists, splitSegmentsWithSeparators, stripHeredocBodies, substitutionBodies, tokenize } from './shell-command.ts';

/** Whether the `run gate` line is still in the script once heredoc bodies are gone. */
const kept = (script: string): boolean => stripHeredocBodies(script).split('\n').includes('run gate');

describe('comments inside a command substitution', () => {
  it('a `)` in a comment does not close the substitution', () => {
    assert.deepEqual(substitutionBodies('echo "$(\n# note )\nrun gate\n)"'), ['\n# note )\nrun gate\n']);
  });

  it('a comment at the end of the script leaves the substitution open', () => {
    assert.deepEqual(substitutionBodies('echo $( # )'), []);
  });

  it('`$#` and `${#x}` are no comments', () => {
    assert.deepEqual(substitutionBodies('echo $(echo $# ${#x})'), ['echo $# ${#x}']);
  });
});

describe('heredoc operators in quotes or comments', () => {
  for (const script of ['echo "use <<EOF here"\nrun gate', "echo 'a <<END'\nrun gate", '# write <<EOF to start one\nrun gate']) {
    it(`keep the next lines: ${JSON.stringify(script)}`, () => {
      assert.equal(kept(script), true);
    });
  }

  for (const script of ['n=$((1 << 2))\nrun gate', '(( n = 1 << 2 ))\nrun gate', 'n=$(( (1 + 1) << 2 ))\nrun gate']) {
    it(`an arithmetic shift opens no heredoc: ${JSON.stringify(script)}`, () => {
      assert.equal(kept(script), true);
    });
  }

  for (const script of ['cat <<EOF\n  EOF\nrun gate\nEOF', 'cat <<-EOF\n\trun gate\n\tEOF']) {
    it(`a body ends only at its exact terminator: ${JSON.stringify(script)}`, () => {
      assert.equal(stripHeredocBodies(script).includes('run gate'), false);
    });
  }

  it('`<<-` ends at a tab-indented terminator', () => {
    assert.equal(kept('cat <<-EOF\n\tbody\n\tEOF\nrun gate'), true);
  });

  it('still strips a real heredoc body', () => {
    assert.equal(stripHeredocBodies('cat <<EOF\nrun gate\nEOF'), 'cat <<EOF');
  });

  it('reads a hyphenated, quoted or concatenated delimiter as one word', () => {
    assert.equal(kept("cat <<'END-OF'\nbody\nEND-OF\nrun gate"), true);
    assert.equal(kept("cat <<'END'-OF\nbody\nEND-OF\nrun gate"), true);
    assert.equal(kept('cat << "E O F"\nbody\nE O F\nrun gate'), true);
    assert.equal(kept('cat <<\\EOF\nbody\nEOF\nrun gate'), true);
  });

  it('a here-string opens no body', () => {
    assert.equal(kept('grep x <<<"$v"\nrun gate'), true);
  });
});

describe('splitAndOrLists', () => {
  const cases: Array<[string, string[]]> = [
    ['a || b; c && d', ['a || b', 'c && d']],
    ['a || b & c', ['a || b &', 'c']],
    ['a &>/dev/null; b', ['a &>/dev/null', 'b']],
    ['a 2>&1; b', ['a 2>&1', 'b']],
    ['a || { echo x; exit 1; }; b', ['a || { echo x; exit 1; }', 'b']],
    ['x=$(a; b) || exit 1', ['x=$(a; b) || exit 1']],
    ["echo 'a; b' || exit 1", ["echo 'a; b' || exit 1"]],
    ["echo $'a\\'; b' || exit 1", ["echo $'a\\'; b' || exit 1"]],
    ['a # b; c\nd', ['a', 'd']],
    ['a\\; b', ['a\\; b']],
    ['case x in y) a;; esac', ['case x in y) a', 'esac']],
    ['; a', ['a']],
    [String.raw`a\\; b; c`, [String.raw`a\\`, 'b', 'c']],
    [String.raw`echo 'a\'; b`, [String.raw`echo 'a\'`, 'b']],
    ['echo "a; b"; c', ['echo "a; b"', 'c']],
    ['# c; d\ne', ['e']],
    ['a # c', ['a']],
    ['(a); b', ['(a)', 'b']],
    ['{ a; }; b', ['{ a; }', 'b']],
    // Every `(` nests here, so a process substitution's `;` stays inside.
    ['echo <(true; run gate)', ['echo <(true; run gate)']],
    ['tee >(a; b); c', ['tee >(a; b)', 'c']],
    // A `&` of a redirection (`>&2`, `&>`, `<&0`) ends nothing.
    ['a >&2; b', ['a >&2', 'b']],
    ['a <&0 b', ['a <&0 b']],
    ['a && b', ['a && b']],
    ['cat <<EOF\nx; y\nEOF\nb', ['cat <<EOF', 'b']],
  ];
  for (const [script, lists] of cases) {
    it(`${JSON.stringify(script)} → ${JSON.stringify(lists)}`, () => {
      assert.deepEqual(splitAndOrLists(script), lists);
    });
  }
});

describe('heredoc bodies end where bash ends them', () => {
  for (const script of ['(( n = 1 )); cat <<EOF\nrun gate\nEOF', 'cat <<A <<A\nx\nA\nrun gate\nA']) {
    it(`strips the body: ${JSON.stringify(script)}`, () => {
      assert.equal(kept(script), false);
    });
  }

  it("reduces a `$'…'` delimiter's escapes to the escaped character", () => {
    assert.equal(kept(String.raw`cat <<$'E\OF'` + '\nbody\nEOF\nrun gate'), true);
  });

  it('an unterminated `<<-` body runs to the end', () => {
    assert.equal(stripHeredocBodies('cat <<-EOF\nbody'), 'cat <<-EOF');
  });

  it('two bodies on one line, in order', () => {
    assert.equal(stripHeredocBodies('cat <<A <<B\na\nA\nb\nB\nrun gate'), 'cat <<A <<B\nrun gate');
  });
});

describe('splitSegmentsWithSeparators', () => {
  const cases: Array<[string, Array<{ text: string; next: string }>]> = [
    [
      'a #b; c\nd',
      [
        { text: 'a', next: '\n' },
        { text: 'd', next: '' },
      ],
    ],
    [
      'echo a# b; c',
      [
        { text: 'echo a# b', next: ';' },
        { text: 'c', next: '' },
      ],
    ],
    [
      String.raw`echo 'a\'; b`,
      [
        { text: String.raw`echo 'a\'`, next: ';' },
        { text: 'b', next: '' },
      ],
    ],
    // A bare `(` opens no substitution: its `;` still separates.
    [
      '(a; b)',
      [
        { text: '(a', next: ';' },
        { text: 'b)', next: '' },
      ],
    ],
    [
      'x=$(a (b) c; d); e',
      [
        { text: 'x=$(a (b) c; d)', next: ';' },
        { text: 'e', next: '' },
      ],
    ],
    [
      'a); echo $(x; y)',
      [
        { text: 'a)', next: ';' },
        { text: 'echo $(x; y)', next: '' },
      ],
    ],
    // A process substitution's separators are its body's, not the script's.
    [
      'diff <(a; b) >(c | d); e',
      [
        { text: 'diff <(a; b) >(c | d)', next: ';' },
        { text: 'e', next: '' },
      ],
    ],
    // An escaped `<` opens nothing: `\<(` is a word and a bare `(`.
    [
      String.raw`echo \<(a; b)`,
      [
        { text: String.raw`echo \<(a`, next: ';' },
        { text: 'b)', next: '' },
      ],
    ],
    // An escaped backslash escapes nothing after it: `\\<(` opens one.
    [
      String.raw`echo \\<(a; b); c`,
      [
        { text: String.raw`echo \\<(a; b)`, next: ';' },
        { text: 'c', next: '' },
      ],
    ],
    // A `>` after an escaped `>` is unescaped: `\>>(` opens one.
    [String.raw`echo \>>(a; b)`, [{ text: String.raw`echo \>>(a; b)`, next: '' }]],
    // A comment inside a substitution leaves its newline in the body.
    [
      'x=$(a # c\nb); d',
      [
        { text: 'x=$(a \nb)', next: ';' },
        { text: 'd', next: '' },
      ],
    ],
    // Operators, doubled and single.
    [
      'a | b || c && d & e',
      [
        { text: 'a', next: '|' },
        { text: 'b', next: '||' },
        { text: 'c', next: '&&' },
        { text: 'd', next: '&' },
        { text: 'e', next: '' },
      ],
    ],
    [
      "printf '%s' 'a | b' | sh",
      [
        { text: "printf '%s' 'a | b'", next: '|' },
        { text: 'sh', next: '' },
      ],
    ],
    [
      'echo "a;b"\\; c',
      [{ text: 'echo "a;b"\\; c', next: '' }],
    ],
  ];
  for (const [script, segments] of cases) {
    it(JSON.stringify(script), () => {
      assert.deepEqual(splitSegmentsWithSeparators(script), segments);
    });
  }
});

describe('tokenize', () => {
  const cases: Array<[string, Array<{ value: string; quoted: boolean }>]> = [
    [' a', [{ value: 'a', quoted: false }]],
    [
      "'a' b",
      [
        { value: 'a', quoted: true },
        { value: 'b', quoted: false },
      ],
    ],
    [
      "$'a' b",
      [
        { value: 'a', quoted: true },
        { value: 'b', quoted: false },
      ],
    ],
    ["'", [{ value: '', quoted: true }]],
    [String.raw`'a\b'`, [{ value: String.raw`a\b`, quoted: true }]],
    [String.raw`a\x41`, [{ value: 'ax41', quoted: false }]],
    [String.raw`a\ b`, [{ value: 'a b', quoted: false }]],
    [String.raw`"a\"b"`, [{ value: 'a"b', quoted: true }]],
    [String.raw`"a\qb"`, [{ value: String.raw`a\qb`, quoted: true }]],
    [String.raw`$'\q'`, [{ value: String.raw`\q`, quoted: true }]],
    [String.raw`$'\a\b\e\E\f\n\r\t\v\\\'\"\?'`, [{ value: '\u0007\b\u001b\u001b\f\n\r\t\v\\\'"?', quoted: true }]],
    [String.raw`$'\x41\x4g\xAf'`, [{ value: 'A\u0004g¯', quoted: true }]],
    // A backslash-newline joins what is on either side.
    ['ru\\\nn gate', [{ value: 'run', quoted: false }, { value: 'gate', quoted: false }]],
    // A lone trailing backslash is a character of the word.
    ['a\\', [{ value: 'a\\', quoted: false }]],
    ['"a b"c', [{ value: 'a bc', quoted: true }]],
    ['', []],
  ];
  for (const [segment, tokens] of cases) {
    it(JSON.stringify(segment), () => {
      assert.deepEqual(tokenize(segment), tokens);
    });
  }
});

describe('substitutionBodies', () => {
  const cases: Array<[string, string[]]> = [
    [String.raw`echo \$(x)`, []],
    ["echo '$(x)'", []],
    [String.raw`echo $'a\'$(x)'`, []],
    ["echo $'a' $(x)", ['x']],
    [`echo "'" $(x)`, ['x']],
    ['echo "$(x)" $(y)', ['x', 'y']],
    ['echo "#" $(x)', ['x']],
    ['a # $(x)\n$(y)', ['y']],
    ['a#$(x)', ['x']],
    ['echo `x` `y\\`z\\``', ['x', 'y`z`']],
    ['echo \\`x\\`', []],
    ['echo `x $(y)', []],
    ['"`x`"', ['x']],
    ['"`x $(y)"', []],
    [String.raw`"\"'$(x)'"`, ['x']],
    ['$((1 + 2)) $(x)', ['x']],
    ['$(a `b`) $(c)', ['a `b`', 'c']],
    ['$(a) $(b', ['a']],
    ['$(echo ")") $(y)', ['echo ")"', 'y']],
    ["$(echo ')') $(y)", ["echo ')'", 'y']],
    [String.raw`$(echo $')\'') $(y)`, [String.raw`echo $')\''`, 'y']],
    [String.raw`$(echo \)) $(y)`, [String.raw`echo \)`, 'y']],
    ['$(a (b) c) $(d)', ['a (b) c', 'd']],
    ['$(#)\n) $(y)', ['#)\n', 'y']],
    ['$(a#)', ['a#']],
  ];
  for (const [script, bodies] of cases) {
    it(`${JSON.stringify(script)} → ${JSON.stringify(bodies)}`, () => {
      assert.deepEqual(substitutionBodies(script), bodies);
    });
  }
});
