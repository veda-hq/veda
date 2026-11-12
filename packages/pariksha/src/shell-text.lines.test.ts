// The line-oriented lexing shell-gates' rules read through: logical lines
// (quoting that spans lines, heredoc bodies, continuations), words, message
// views and command positions. Ported case for case from the original's
// suite; each edge is pinned on the lexer's own output, so a regression shows
// as the exact text that changed rather than as a rule that went quiet.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeLines, commandAt, commandPositions, maskQuoted, messageView, stripComment, words } from './shell-text.ts';

describe('stripComment, as the line rules read it', () => {
  it('ends a quoted $(…) body at its comment, nested parens included', () => {
    assert.equal(stripComment('X="$(echo a # note'), 'X="$(echo a');
    assert.equal(stripComment('X="$(f (a) # c'), 'X="$(f (a)');
    // Past the `)` the outer string is still open: `# c` is its text.
    assert.equal(stripComment('X="$(f "a # b") # c'), 'X="$(f "a # b") # c');
    assert.equal(stripComment('X="$(f "a # b")" # c'), 'X="$(f "a # b")"');
  });
});

describe('maskQuoted, as the line rules read it', () => {
  it('masks $((…)) arithmetic in double quotes as text', () => {
    assert.equal(maskQuoted('"$((1 + 2)) x"'), '"            "');
  });

  it("closes no substitution on a case arm's )", () => {
    assert.equal(maskQuoted('"$(case $x in a) y;; esac) z"'), '"$(case $x in a) y;; esac)  "');
  });
});

describe('messageView', () => {
  for (const [code, view] of [
    ['echo $HOME is set', 'echo             '],
    ['echo 42 apples', 'echo          '],
    ['echo "x" 5', 'echo      '],
  ] as const) {
    it(`blanks the message words of ${JSON.stringify(code)}`, () => {
      assert.equal(messageView(code), view);
    });
  }

  it('returns code with no echo or printf unchanged', () => {
    assert.equal(messageView('node "a b"'), 'node "a b"');
  });

  it('keeps substitutions, nested parens and backticks included', () => {
    assert.equal(messageView('echo $(a (b) c) msg; node'), 'echo $(a (b) c)    ; node');
    assert.equal(messageView('echo `date` msg; node'), 'echo `date`    ; node');
  });

  it('keeps a redirection and its target, with its fd digit', () => {
    assert.equal(messageView('echo hi 2>/dev/null'), 'echo    2>/dev/null');
    assert.equal(messageView('echo a &> log more'), 'echo   &> log     ');
    assert.equal(messageView('echo a > f;node x'), 'echo   > f;node x');
  });

  it('ends a message at & and keeps what follows', () => {
    assert.equal(messageView('echo hi & node x'), 'echo    & node x');
    assert.equal(messageView('printf "%s" a | node'), 'printf        | node');
  });
});

describe('words', () => {
  for (const [code, expected] of [
    ['echo "a b"', ['echo', '"a b"']],
    ["echo 'a b' c", ['echo', "'a b'", 'c']],
    ['echo "a\\" b" c', ['echo', '"a\\" b"', 'c']],
    ["echo 'a\\' b", ['echo', "'a\\'", 'b']],
    ['echo a\\ b', ['echo', 'a\\ b']],
    ['echo a\\', ['echo', 'a\\']],
    ['echo ${a:-x y} z', ['echo', '${a:-x y}', 'z']],
    ['echo ${a} b', ['echo', '${a}', 'b']],
    ['echo {a b}', ['echo', '{a', 'b}']],
    ['echo $(a (b) c) d', ['echo', '$(a (b) c)', 'd']],
    ['a b|c', ['a', 'b']],
    ['a b;c', ['a', 'b']],
    ['a b&c', ['a', 'b']],
    ['a b)c', ['a', 'b']],
    ['  a   b  ', ['a', 'b']],
  ] as const) {
    it(`splits ${JSON.stringify(code)}`, () => {
      assert.deepEqual(words(code), expected);
    });
  }
});

describe('codeLines', () => {
  const cases: Array<[string, Array<{ line: number; code: string }>]> = [
    [
      'a\n\nb',
      [
        { line: 1, code: 'a' },
        { line: 3, code: 'b' },
      ],
    ],
    ['a\n\\', [{ line: 1, code: 'a' }]],
    [
      'a\n# c\n  # d\nb # e',
      [
        { line: 1, code: 'a' },
        { line: 4, code: 'b' },
      ],
    ],
    ['echo "a', [{ line: 1, code: 'echo "a' }]],
    ['no\\\nde x.js', [{ line: 1, code: 'node x.js' }]],
  ];
  for (const [text, lines] of cases) {
    it(`reads ${JSON.stringify(text)}`, () => {
      assert.deepEqual(codeLines(text), lines);
    });
  }

  it('keeps a quoted string spanning lines as one logical line', () => {
    assert.deepEqual(codeLines('echo "a\nb" c'), [{ line: 1, code: 'echo "a\nb" c' }]);
    assert.deepEqual(codeLines('echo "a\nb" "c\nd"'), [{ line: 1, code: 'echo "a\nb" "c\nd"' }]);
    assert.deepEqual(codeLines('( echo "a\nb" )\nnode'), [
      { line: 1, code: '( echo "a\nb" )' },
      { line: 3, code: 'node' },
    ]);
  });

  it('removes a backslash-newline in double quotes, keeps it in single', () => {
    assert.deepEqual(codeLines('X="$(no\\\nde x)"'), [{ line: 1, code: 'X="$(node x)"' }]);
    assert.deepEqual(codeLines("echo 'a\\\nb'"), [{ line: 1, code: "echo 'a\\\nb'" }]);
  });

  it('continues code after a closing quote that ends in a backslash', () => {
    assert.deepEqual(codeLines('echo "a\nb" \\\nnode'), [{ line: 1, code: 'echo "a\nb" node' }]);
  });

  it('strips a comment line inside a continuation, as bash does', () => {
    assert.deepEqual(codeLines('echo a \\\n# c\nnode x'), [
      { line: 1, code: 'echo a ' },
      { line: 3, code: 'node x' },
    ]);
  });

  it('carries the nesting of a quoted $(…) across lines', () => {
    assert.deepEqual(codeLines('X="$(f (a) b\nc)"\nnode'), [
      { line: 1, code: 'X="$(f (a) b\nc)"' },
      { line: 3, code: 'node' },
    ]);
    assert.deepEqual(codeLines('X="$(printf "%s\n" x) node is text"\nnpm'), [
      { line: 1, code: 'X="$(printf "%s\n" x) node is text"' },
      { line: 3, code: 'npm' },
    ]);
  });

  it('ends a physical line at a comment inside a quoted $(…) that stays open', () => {
    assert.deepEqual(codeLines('X="$(a\nb # c\nd)"'), [{ line: 1, code: 'X="$(a\nb\nd)"' }]);
  });

  describe('heredocs', () => {
    for (const [text, opener] of [
      ["cat <<'E O'\nnode\nE O\nnpm", "cat <<'E O'"],
      ['cat <<"END"\nnode\nEND\nnpm', 'cat <<"END"'],
      ['cat <<\\EOF\nnode\nEOF\nnpm', 'cat <<\\EOF'],
      ['cat <<-EOF\n\tnode\n\tEOF\nnpm', 'cat <<-EOF'],
    ] as const) {
      it(`drops the body of ${JSON.stringify(text)} through its delimiter`, () => {
        assert.deepEqual(codeLines(text), [
          { line: 1, code: opener },
          { line: 4, code: 'npm' },
        ]);
      });
    }

    it('ends a body only on an exact delimiter line', () => {
      assert.deepEqual(codeLines('cat <<EOF\nnode\nEOF \nEOF\nnpm'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 5, code: 'npm' },
      ]);
    });

    it('opens none for a here-string or a shift', () => {
      assert.deepEqual(codeLines('cat <<<"$x"\nnode'), [
        { line: 1, code: 'cat <<<"$x"' },
        { line: 2, code: 'node' },
      ]);
      assert.deepEqual(codeLines('x=$(( 1 << 2 ))\nnode'), [
        { line: 1, code: 'x=$(( 1 << 2 ))' },
        { line: 2, code: 'node' },
      ]);
    });

    it('starts the body after a continued command line ends', () => {
      assert.deepEqual(codeLines('cat <<EOF \\\n> out\nbody\nEOF\nnode'), [
        { line: 1, code: 'cat <<EOF > out' },
        { line: 5, code: 'node' },
      ]);
    });

    it('keeps only the substitutions an expanding body runs', () => {
      assert.deepEqual(codeLines('cat <<EOF\necho "$(node x)"\nEOF\n'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '      $(node x) ' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\nplain text\nEOF\nnode'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 4, code: 'node' },
      ]);
    });

    it('judges each closed substitution on its own line', () => {
      assert.deepEqual(codeLines('cat <<EOF\n$(node x)\n$(npm y)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '$(node x)' },
        { line: 3, code: '$(npm y)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\na $(node x)\n$(npm y)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '  $(node x)' },
        { line: 3, code: '$(npm y)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\n`node x`\n`npm y`\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '`node x`' },
        { line: 3, code: '`npm y`' },
      ]);
    });

    it('joins a backslash-newline inside a body substitution, as bash does', () => {
      assert.deepEqual(codeLines('cat <<EOF\n$(no\\\nde x)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '$(node x)' },
      ]);
    });

    it('judges a substitution spanning body lines whole', () => {
      assert.deepEqual(codeLines('cat <<EOF\n$(node\nx)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '$(node\nx)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\n`node\nx`\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '`node\nx`' },
      ]);
    });

    it('opens no substitution on an escaped $( or a bare (', () => {
      assert.deepEqual(codeLines('cat <<EOF\na \\$( b\n$(node x)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 3, code: '$(node x)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\na (b\n$(node x)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 3, code: '$(node x)' },
      ]);
      assert.deepEqual(codeLines('cat <<EOF\n$((1 + 2)) (\n$(node x)\nEOF'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 3, code: '$(node x)' },
      ]);
    });

    it('still runs the substitutions of an unterminated body', () => {
      assert.deepEqual(codeLines('cat <<EOF\n$(node\nx'), [
        { line: 1, code: 'cat <<EOF' },
        { line: 2, code: '$(node\nx' },
      ]);
    });

    it('starts a body after a quote that opens on its opener line', () => {
      assert.deepEqual(codeLines('X="$(cat <<EOF\nnode\nEOF\n)"\nnpm'), [
        { line: 1, code: 'X="$(cat <<EOF\n)"' },
        { line: 5, code: 'npm' },
      ]);
    });

    it('reads a backslash inside single quotes as literal, not an escape', () => {
      // `'a\'` is the word a\ and closes its quote, so the opener line ends
      // there and the body starts on line 2.
      assert.deepEqual(codeLines('X="$(cat <<EOF; echo \'a\\\'\nnode\nEOF\n)"\nnpm'), [
        { line: 1, code: 'X="$(cat <<EOF; echo \'a\\\'\n)"' },
        { line: 5, code: 'npm' },
      ]);
    });

    // bash reads each of these with the body after the string closes, and
    // runs the last line (checked against bash 5).
    for (const [quote, text, opener] of [
      ['double', 'cat <<EOF; echo "a\nb"\nnode\nEOF\nnpm', 'cat <<EOF; echo "a\nb"'],
      ['single, ending in a backslash', "cat <<EOF; echo 'a \\\nb'\nnode\nEOF\nnpm", "cat <<EOF; echo 'a \\\nb'"],
    ] as const) {
      it(`starts no body inside a ${quote}-quoted string the opener line leaves open`, () => {
        assert.deepEqual(codeLines(text), [
          { line: 1, code: opener },
          { line: 5, code: 'npm' },
        ]);
      });
    }

    it('starts no body inside a string nested in a quoted substitution', () => {
      assert.deepEqual(codeLines('X="$(cat <<EOF; echo \'a \\\nb\'\nnode\nEOF\n)"\nnpm'), [
        { line: 1, code: 'X="$(cat <<EOF; echo \'a \\\nb\'\n)"' },
        { line: 6, code: 'npm' },
      ]);
    });

    it('opens a heredoc in the code after a string closes', () => {
      assert.deepEqual(codeLines("printf '%s' 'help\n'; cat <<'EOF'\nnode\nEOF\nnpm"), [
        { line: 1, code: "printf '%s' 'help\n'; cat <<'EOF'" },
        { line: 5, code: 'npm' },
      ]);
    });
  });
});

describe('commandPositions', () => {
  const cases: Array<[string, string, number[]]> = [
    ['"node" x', 'node', [6]],
    ['a |& node x', 'node', [9]],
    ['a | node x', 'node', [8]],
    ['case $x in node) npm ;; esac', 'node', []],
    ['case $x in a|node) npm ;; esac', 'node', []],
    ['case $x in a) node ;; esac', 'node', [18]],
    ['lint) node x ;;', 'node', [10]],
    ['echo if node', 'node', []],
    ['if node; then :; fi', 'node', [7]],
    ['env -u X node a', 'node', [13]],
    ['/usr/bin/node a', 'node', [13]],
    ['echo "node x"', 'node', []],
    ['X="$(node x)"', 'node', [9]],
    ['nodejs x', 'node', []],
    ['node.js x', 'node.js', [7]],
    ['nodexjs x', 'node.js', []],
    ['echo $(a) node', 'node', []],
    ['X=1 node a', 'node', [8]],
    ['>/dev/null node a', 'node', [15]],
    ['x=`node a`', 'node', [7]],
  ];
  for (const [code, command, ends] of cases) {
    it(`finds ${JSON.stringify(code)} running ${command} at ${JSON.stringify(ends)}`, () => {
      assert.deepEqual(commandPositions(code, command), ends);
    });
  }

  it('returns the first position, or -1', () => {
    assert.equal(commandAt('a; node x; node y', 'node'), 7);
    assert.equal(commandAt('echo node', 'node'), -1);
  });
});
